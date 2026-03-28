/**
 * Workflow Audit & Telemetry
 * 
 * Exposes durable orchestration state for audit/telemetry without making telemetry canonical.
 * Derives metrics from persisted workflow state.
 */

import { WorkflowState, WorkflowDefinition } from "./types.ts";
import { loadState, loadDefinition, listAll, getWorkflowStats } from "./workflow-state.ts";

/**
 * Workflow telemetry snapshot
 */
export interface WorkflowTelemetry {
  workflowId: string;
  status: WorkflowState["status"];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  taskCounts: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    ready: number;
    blocked: number;
    continued: number;
  };
  retryCount: number;
  error?: {
    taskId?: string;
    type?: string;
    message: string;
  };
}

/**
 * Aggregated telemetry for all workflows
 */
export interface AggregatedTelemetry {
  timestamp: string;
  workflows: {
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
  tasks: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    ready: number;
    blocked: number;
    continued: number;
  };
  averageDurationMs?: number;
  retryRate: number;
}

/**
 * Telemetry record for audit trail
 */
export interface TelemetryRecord {
  timestamp: string;
  workflowId: string;
  event: "created" | "started" | "task_started" | "task_completed" | "task_failed" | "workflow_completed" | "workflow_failed" | "workflow_cancelled";
  taskId?: string;
  details?: Record<string, unknown>;
}

/**
 * Get telemetry for a single workflow
 */
export async function getWorkflowTelemetry(workflowId: string): Promise<WorkflowTelemetry | null> {
  const state = await loadState(workflowId);
  if (!state) {
    return null;
  }
  
  const definition = await loadDefinition(workflowId);
  
  // Calculate retry count
  let retryCount = 0;
  for (const taskState of Object.values(state.taskStates)) {
    retryCount += taskState.attemptCount;
  }
  
  // Calculate duration
  let durationMs: number | undefined;
  if (state.completedAt && state.startedAt) {
    durationMs = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
  } else if (state.startedAt) {
    durationMs = Date.now() - new Date(state.startedAt).getTime();
  }
  
  const totalTasks = definition?.tasks.length || Object.keys(state.taskStates).length;
  
  return {
    workflowId: state.workflowId,
    status: state.status,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    durationMs,
    taskCounts: {
      total: totalTasks,
      completed: state.completedTasks.length,
      failed: state.failedTasks.length,
      running: state.runningTasks.length,
      ready: state.readyTasks.length,
      blocked: state.blockedTasks.length,
      continued: state.continuedTasks?.length || 0
    },
    retryCount,
    error: state.error
  };
}

/**
 * Get all active workflows with telemetry
 */
export async function getActiveWorkflows(): Promise<WorkflowTelemetry[]> {
  const allWorkflowIds = await listAll();
  const active: WorkflowTelemetry[] = [];
  
  for (const workflowId of allWorkflowIds) {
    const telemetry = await getWorkflowTelemetry(workflowId);
    if (telemetry && !isTerminalStatus(telemetry.status)) {
      active.push(telemetry);
    }
  }
  
  return active;
}

/**
 * Get all completed workflows with telemetry
 */
export async function getCompletedWorkflows(): Promise<WorkflowTelemetry[]> {
  const allWorkflowIds = await listAll();
  const completed: WorkflowTelemetry[] = [];
  
  for (const workflowId of allWorkflowIds) {
    const telemetry = await getWorkflowTelemetry(workflowId);
    if (telemetry && telemetry.status === "completed") {
      completed.push(telemetry);
    }
  }
  
  return completed;
}

/**
 * Get all failed workflows with telemetry
 */
export async function getFailedWorkflows(): Promise<WorkflowTelemetry[]> {
  const allWorkflowIds = await listAll();
  const failed: WorkflowTelemetry[] = [];
  
  for (const workflowId of allWorkflowIds) {
    const telemetry = await getWorkflowTelemetry(workflowId);
    if (telemetry && telemetry.status === "failed") {
      failed.push(telemetry);
    }
  }
  
  return failed;
}

/**
 * Check if status is terminal
 */
function isTerminalStatus(status: WorkflowState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Get aggregated telemetry across all workflows
 */
export async function getAggregatedTelemetry(): Promise<AggregatedTelemetry> {
  const stats = await getWorkflowStats();
  const allWorkflowIds = await listAll();
  
  let totalRetryCount = 0;
  let totalDurationMs = 0;
  let durationCount = 0;
  
  let totalTaskCount = 0;
  let completedTaskCount = 0;
  let failedTaskCount = 0;
  let runningTaskCount = 0;
  let readyTaskCount = 0;
  let blockedTaskCount = 0;
  let continuedTaskCount = 0;
  
  for (const workflowId of allWorkflowIds) {
    const telemetry = await getWorkflowTelemetry(workflowId);
    if (!telemetry) continue;
    
    totalRetryCount += telemetry.retryCount;
    
    if (telemetry.durationMs) {
      totalDurationMs += telemetry.durationMs;
      durationCount++;
    }
    
    totalTaskCount += telemetry.taskCounts.total;
    completedTaskCount += telemetry.taskCounts.completed;
    failedTaskCount += telemetry.taskCounts.failed;
    runningTaskCount += telemetry.taskCounts.running;
    readyTaskCount += telemetry.taskCounts.ready;
    blockedTaskCount += telemetry.taskCounts.blocked;
    continuedTaskCount += telemetry.taskCounts.continued;
  }
  
  return {
    timestamp: new Date().toISOString(),
    workflows: {
      active: stats.active,
      completed: stats.completed,
      failed: stats.failed,
      cancelled: stats.total - stats.active - stats.completed - stats.failed,
      total: stats.total
    },
    tasks: {
      total: totalTaskCount,
      completed: completedTaskCount,
      failed: failedTaskCount,
      running: runningTaskCount,
      ready: readyTaskCount,
      blocked: blockedTaskCount,
      continued: continuedTaskCount
    },
    averageDurationMs: durationCount > 0 ? totalDurationMs / durationCount : undefined,
    retryRate: totalTaskCount > 0 ? totalRetryCount / totalTaskCount : 0
  };
}

/**
 * Generate telemetry records for audit trail
 * These are derived from persisted state, not a separate store
 */
export async function generateAuditRecords(workflowId: string): Promise<TelemetryRecord[]> {
  const state = await loadState(workflowId);
  if (!state) {
    return [];
  }
  
  const records: TelemetryRecord[] = [];
  
  // Workflow created
  records.push({
    timestamp: state.createdAt,
    workflowId: state.workflowId,
    event: "created"
  });
  
  // Workflow started
  if (state.startedAt) {
    records.push({
      timestamp: state.startedAt,
      workflowId: state.workflowId,
      event: "started"
    });
  }
  
  // Task events
  for (const taskState of Object.values(state.taskStates)) {
    if (taskState.lastAttemptAt) {
      records.push({
        timestamp: taskState.lastAttemptAt,
        workflowId: state.workflowId,
        event: "task_started",
        taskId: taskState.taskId
      });
    }
    
    if (taskState.completedAt) {
      const event: TelemetryRecord["event"] = 
        taskState.status === "failed" ? "task_failed" : "task_completed";
      
      records.push({
        timestamp: taskState.completedAt,
        workflowId: state.workflowId,
        event,
        taskId: taskState.taskId,
        details: {
          attemptCount: taskState.attemptCount,
          error: taskState.error
        }
      });
    }
  }
  
  // Workflow completed/failed/cancelled
  if (state.completedAt) {
    const event: TelemetryRecord["event"] =
      state.status === "completed" ? "workflow_completed" :
      state.status === "failed" ? "workflow_failed" :
      "workflow_cancelled";
    
    records.push({
      timestamp: state.completedAt,
      workflowId: state.workflowId,
      event,
      details: { error: state.error }
    });
  }
  
  // Sort by timestamp
  records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  
  return records;
}

/**
 * Telemetry API response format
 */
export interface TelemetryAPIResponse {
  success: boolean;
  data?: {
    active?: WorkflowTelemetry[];
    completed?: WorkflowTelemetry[];
    failed?: WorkflowTelemetry[];
    aggregated?: AggregatedTelemetry;
    workflow?: WorkflowTelemetry;
    audit?: TelemetryRecord[];
  };
  error?: string;
}

/**
 * Get telemetry API response
 */
export async function getTelemetryAPI(
  options: {
    active?: boolean;
    completed?: boolean;
    failed?: boolean;
    aggregated?: boolean;
    workflowId?: string;
    audit?: boolean;
  }
): Promise<TelemetryAPIResponse> {
  try {
    const data: TelemetryAPIResponse["data"] = {};
    
    if (options.workflowId) {
      data.workflow = await getWorkflowTelemetry(options.workflowId) || undefined;
    }
    
    if (options.active) {
      data.active = await getActiveWorkflows();
    }
    
    if (options.completed) {
      data.completed = await getCompletedWorkflows();
    }
    
    if (options.failed) {
      data.failed = await getFailedWorkflows();
    }
    
    if (options.aggregated) {
      data.aggregated = await getAggregatedTelemetry();
    }
    
    if (options.audit && options.workflowId) {
      data.audit = await generateAuditRecords(options.workflowId);
    }
    
    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
