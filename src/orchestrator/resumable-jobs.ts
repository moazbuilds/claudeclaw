/**
 * Resumable Jobs Integration
 * 
 * Wraps existing scheduled/job execution paths in durable workflow orchestration.
 * Provides cron trigger integration and daemon restart recovery.
 */

import { WorkflowDefinition, TaskDefinition, WorkflowState } from "./types.ts";
import { createWorkflow, saveDefinition, saveState, loadState, listActive, loadDefinition } from "./workflow-state.ts";
import { executeWorkflow, resumeWorkflow, registerHandlers, setGovernanceClient } from "./executor.ts";
import { validateWorkflow } from "./task-graph.ts";
import { OrchestratorGovernanceAdapter } from "./governance-adapter.ts";

/**
 * Job definition that can be converted to a workflow
 */
export interface JobDefinition {
  id: string;
  type: string;
  name?: string;
  schedule?: string; // cron expression
  actionRef: string;
  input?: Record<string, unknown>;
  onError?: "fail_workflow" | "continue" | "retry_task";
  maxRetries?: number;
  retryPolicy?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  };
  sessionId?: string;
  source?: string;
  channelId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pending job for resumable execution
 */
export interface PendingJob {
  jobId: string;
  workflowId: string;
  status: "pending" | "active";
  createdAt: string;
  scheduledFor?: string;
}

/**
 * Pending jobs storage
 */
const PENDING_JOBS_FILE = ".claude/claudeclaw/pending-jobs.json";

/**
 * Load pending jobs from disk
 */
async function loadPendingJobs(): Promise<PendingJob[]> {
  try {
    const { readFile } = await import("fs/promises");
    const { existsSync } = await import("fs");
    if (!existsSync(PENDING_JOBS_FILE)) {
      return [];
    }
    const content = await readFile(PENDING_JOBS_FILE, "utf-8");
    return JSON.parse(content) as PendingJob[];
  } catch {
    return [];
  }
}

/**
 * Save pending jobs to disk
 */
async function savePendingJobs(jobs: PendingJob[]): Promise<void> {
  const { writeFile } = await import("fs/promises");
  const { dirname } = await import("path");
  const { mkdir } = await import("fs/promises");
  const { existsSync } = await import("fs");
  
  const dir = dirname(PENDING_JOBS_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  
  await writeFile(PENDING_JOBS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
}

/**
 * Create a workflow from a job definition
 */
export function createWorkflowForJob(job: JobDefinition): WorkflowDefinition {
  const task: TaskDefinition = {
    id: `${job.id}-task`,
    type: job.type,
    deps: [],
    actionRef: job.actionRef,
    input: job.input,
    onError: job.onError || "fail_workflow",
    maxRetries: job.maxRetries,
    retryPolicy: job.retryPolicy
  };
  
  return {
    id: `wf-${job.id}-${Date.now()}`,
    type: job.type,
    sessionId: job.sessionId,
    source: job.source || "job",
    channelId: job.channelId,
    threadId: job.threadId,
    metadata: {
      ...job.metadata,
      jobId: job.id,
      jobName: job.name,
      scheduledAt: job.schedule
    },
    tasks: [task]
  };
}

/**
 * Schedule a job for durable execution
 */
export async function scheduleJob(job: JobDefinition): Promise<{ workflowId: string; jobId: string }> {
  // Validate job has required fields
  if (!job.id || !job.actionRef) {
    throw new Error("Job must have id and actionRef");
  }
  
  // Create workflow from job
  const workflow = createWorkflowForJob(job);
  
  // Validate workflow
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    throw new Error(`Invalid workflow: ${validation.errors.join(", ")}`);
  }
  
  // Create and persist workflow state
  await createWorkflow(workflow, { persistDefinition: true });
  
  // Track as pending job
  const pendingJob: PendingJob = {
    jobId: job.id,
    workflowId: workflow.id,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  
  const jobs = await loadPendingJobs();
  jobs.push(pendingJob);
  await savePendingJobs(jobs);
  
  return { workflowId: workflow.id, jobId: job.id };
}

/**
 * Resume all pending jobs
 * Called on daemon startup to restore workflow state
 */
export async function resumePending(): Promise<{ resumed: number; failed: number }> {
  const pendingJobs = await loadPendingJobs();
  const activeJobs = pendingJobs.filter(j => j.status === "pending" || j.status === "active");

  let resumed = 0;
  let failed = 0;

  // Collect IDs to remove after iteration (avoids splice-during-iteration corruption)
  const removeIds = new Set<string>();
  // Track jobs that should be marked active
  const activateIds = new Set<string>();

  for (const job of activeJobs) {
    try {
      // Load workflow state
      const state = await loadState(job.workflowId);

      if (!state) {
        // Workflow state missing - mark for removal
        console.warn(`Workflow state missing for job ${job.jobId}, removing from pending`);
        removeIds.add(job.workflowId);
        failed++;
        continue;
      }

      // Resume workflow execution
      const updatedState = await resumeWorkflow(job.workflowId);

      if (updatedState) {
        if (updatedState.status === "completed" || updatedState.status === "failed") {
          // Workflow finished - mark for removal
          removeIds.add(job.workflowId);
        } else {
          // Still running
          activateIds.add(job.workflowId);
        }
        resumed++;
      }
    } catch (err) {
      console.error(`Failed to resume job ${job.jobId}:`, err);
      failed++;
    }
  }

  // Build updated list immutably: remove finished jobs, activate running ones
  const remaining = pendingJobs
    .filter(j => !removeIds.has(j.workflowId))
    .map(j => activateIds.has(j.workflowId) ? { ...j, status: "active" as const } : j);
  await savePendingJobs(remaining);

  return { resumed, failed };
}

/**
 * Get count of pending jobs
 */
export async function getPendingCount(): Promise<number> {
  const jobs = await loadPendingJobs();
  return jobs.filter(j => j.status === "pending").length;
}

/**
 * Get all pending jobs
 */
export async function getPendingJobs(): Promise<PendingJob[]> {
  return loadPendingJobs();
}

/**
 * Initialize job system - called on daemon startup
 * Must be called before any job scheduling
 */
export async function initializeJobSystem(): Promise<{
  pendingResumed: number;
  pendingFailed: number;
}> {
  // Wire governance adapter so task-level governance checks actually run
  setGovernanceClient(new OrchestratorGovernanceAdapter());

  // Resume any workflows that were in progress when daemon stopped
  const result = await resumePending();
  
  // Also rebuild from active workflows
  const activeWorkflows = await listActive();
  
  // Add any orphaned active workflows to pending tracking
  const pendingJobs = await loadPendingJobs();
  const trackedWorkflowIds = new Set(pendingJobs.map(j => j.workflowId));
  
  for (const workflowId of activeWorkflows) {
    if (!trackedWorkflowIds.has(workflowId)) {
      // Orphaned active workflow - add to tracking
      const state = await loadState(workflowId);
      if (state) {
        const def = await loadDefinition(workflowId);
        const jobId = def?.metadata?.jobId as string || workflowId;
        
        pendingJobs.push({
          jobId,
          workflowId,
          status: "active",
          createdAt: state.createdAt
        });
        
        trackedWorkflowIds.add(workflowId);
      }
    }
  }
  
  await savePendingJobs(pendingJobs);
  
  return { pendingResumed: result.resumed, pendingFailed: result.failed };
}

/**
 * Process a cron trigger - creates workflow from cron job definition
 */
export async function processCronTrigger(job: JobDefinition): Promise<{ workflowId: string; jobId: string }> {
  // Add cron metadata
  const cronJob: JobDefinition = {
    ...job,
    source: "cron"
  };
  
  return scheduleJob(cronJob);
}

/**
 * Map existing jobs.ts jobs to workflow-backed jobs
 * This is the integration point with the legacy jobs system
 */
export interface LegacyJobAdapter {
  toJobDefinition(): JobDefinition;
}

export function adaptLegacyJob(legacyJob: LegacyJobAdapter): JobDefinition {
  return legacyJob.toJobDefinition();
}

/**
 * Execute a single job immediately (fire-and-forget)
 */
export async function executeJobNow(job: JobDefinition): Promise<string> {
  const { workflowId } = await scheduleJob(job);
  
  // Execute workflow asynchronously
  executeWorkflow(workflowId).catch(err => {
    console.error(`Job ${job.id} execution failed:`, err);
  });
  
  return workflowId;
}

/**
 * Register job action handlers from existing jobs.ts
 */
export function registerJobHandlers(
  handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>>
): void {
  const adaptedHandlers: Record<string, (input: Record<string, unknown>, context: any) => Promise<unknown>> = {};
  
  for (const [key, handler] of Object.entries(handlers)) {
    adaptedHandlers[key] = async (input, _context) => {
      return handler(input);
    };
  }
  
  registerHandlers({
    actions: adaptedHandlers,
    compensations: {}
  });
}
