/**
 * Workflow State Store
 * 
 * Persists canonical workflow state and supports restart-safe loading/reconstruction.
 * State is stored durably under .claude/claudeclaw/workflows/
 */

import { join } from "path";
import { mkdir, readdir, rename, readFile, writeFile, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { WorkflowState, WorkflowDefinition } from "./types.ts";
import { initializeWorkflowState } from "./task-graph.ts";

const WORKFLOWS_DIR = join(process.cwd(), ".claude", "claudeclaw", "workflows");

/** Maximum number of workflow definitions to retain in definitions.json */
const MAX_STORED_DEFINITIONS = 1000;

/**
 * Simple write queue to serialize read-modify-write operations on definitions.json.
 * Prevents concurrent writes from clobbering each other.
 */
let definitionWriteQueue: Promise<void> = Promise.resolve();

function enqueueDefinitionWrite(fn: () => Promise<void>): Promise<void> {
  const task = definitionWriteQueue.then(fn);
  definitionWriteQueue = task.catch(() => {});
  return task;
}

/**
 * Ensure the workflows directory exists
 */
async function ensureWorkflowsDir(): Promise<void> {
  if (!existsSync(WORKFLOWS_DIR)) {
    await mkdir(WORKFLOWS_DIR, { recursive: true });
  }
}

/**
 * Get the path for a workflow state file
 */
function getWorkflowPath(workflowId: string): string {
  return join(WORKFLOWS_DIR, `${workflowId}.json`);
}

/**
 * Get the path for workflow definitions
 */
function getDefinitionsPath(): string {
  return join(WORKFLOWS_DIR, "definitions.json");
}

/**
 * Save workflow state durably
 * Uses atomic write with temp file + rename for crash safety
 */
export async function saveState(state: WorkflowState): Promise<void> {
  await ensureWorkflowsDir();
  
  const path = getWorkflowPath(state.workflowId);
  const tempPath = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  
  // Write to temp file first, then atomic rename for crash safety.
  // NOTE: writeFile + rename provides atomicity but not full durability.
  // A crash between writeFile and rename could lose the write.
  // For full durability, use fd.sync() before rename. Accepted trade-off
  // for performance given the daemon's checkpoint interval.
  const content = JSON.stringify(state, null, 2);
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "w" });

  // Atomic rename to final location
  try {
    await rename(tempPath, path);
  } catch (err) {
    // If rename fails, try to clean up temp and report
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Load workflow state by ID
 * Returns null if workflow doesn't exist
 */
export async function loadState(workflowId: string): Promise<WorkflowState | null> {
  const path = getWorkflowPath(workflowId);
  
  try {
    const content = await readFile(path, { encoding: "utf-8" });
    const state = JSON.parse(content) as WorkflowState;
    return state;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Load workflow state with corruption handling
 * Returns null if workflow is missing or corrupt
 */
export async function loadStateSafe(workflowId: string): Promise<WorkflowState | null> {
  try {
    return await loadState(workflowId);
  } catch {
    // Corruption or read error - workflow cannot be safely loaded
    return null;
  }
}

/**
 * List all active (non-terminal) workflows
 */
export async function listActive(): Promise<string[]> {
  await ensureWorkflowsDir();
  
  const active: string[] = [];
  
  try {
    const entries = await readdir(WORKFLOWS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.includes("definitions")) {
        continue;
      }
      
      const workflowId = entry.replace(".json", "");
      const state = await loadStateSafe(workflowId);
      
      if (state && !isTerminalState(state.status)) {
        active.push(workflowId);
      }
    }
  } catch {
    // Directory might not exist yet
  }
  
  return active;
}

/**
 * List all workflow IDs (including terminal states)
 */
export async function listAll(): Promise<string[]> {
  await ensureWorkflowsDir();
  
  const all: string[] = [];
  
  try {
    const entries = await readdir(WORKFLOWS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.includes("definitions")) {
        continue;
      }
      all.push(entry.replace(".json", ""));
    }
  } catch {
    // Directory might not exist yet
  }
  
  return all;
}

/**
 * Check if a status is terminal (no further execution possible)
 */
function isTerminalState(status: WorkflowState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Save workflow definition for restart reconstruction.
 * Serialized through a write queue to prevent concurrent read-modify-write races.
 */
export async function saveDefinition(definition: WorkflowDefinition): Promise<void> {
  return enqueueDefinitionWrite(async () => {
    await ensureWorkflowsDir();

    const path = getDefinitionsPath();
    let definitions: Record<string, WorkflowDefinition> = {};

    try {
      const content = await readFile(path, { encoding: "utf-8" });
      definitions = JSON.parse(content);
    } catch {
      // File doesn't exist or is corrupt, start fresh
    }

    definitions[definition.id] = definition;

    // Prune oldest definitions when the store exceeds the cap
    const defKeys = Object.keys(definitions);
    if (defKeys.length > MAX_STORED_DEFINITIONS) {
      const entries = Object.entries(definitions);
      // Sort by createdAt (or id as fallback) so oldest come first
      entries.sort((a, b) => {
        const aTime = (a[1] as any).createdAt || a[0];
        const bTime = (b[1] as any).createdAt || b[0];
        return String(aTime).localeCompare(String(bTime));
      });
      const toRemove = entries.slice(0, entries.length - MAX_STORED_DEFINITIONS);
      for (const [id] of toRemove) {
        delete definitions[id];
      }
    }

    const tempPath = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tempPath, JSON.stringify(definitions, null, 2), { encoding: "utf-8", flag: "w" });

    try {
      await rename(tempPath, path);
    } catch {
      try {
        await unlink(tempPath);
      } catch {
        // Ignore
      }
      throw new Error("Failed to save workflow definition");
    }
  });
}

/**
 * Load workflow definition by ID
 */
export async function loadDefinition(workflowId: string): Promise<WorkflowDefinition | null> {
  const path = getDefinitionsPath();
  
  try {
    const content = await readFile(path, { encoding: "utf-8" });
    const definitions = JSON.parse(content) as Record<string, WorkflowDefinition>;
    return definitions[workflowId] || null;
  } catch {
    return null;
  }
}

/**
 * Rebuild the execution view from persisted state
 * This reconstructs ready/running states after restart
 */
export function rebuildExecutionView(
  state: WorkflowState,
  definition: WorkflowDefinition
): WorkflowState {
  const now = new Date().toISOString();
  
  // Rebuild completedOrFailed set
  const completedOrFailed = new Set([
    ...state.completedTasks,
    ...state.failedTasks,
    ...(state.continuedTasks || [])
  ]);
  
  // Rebuild task states for tasks not yet in terminal state
  const newTaskStates = { ...state.taskStates };
  let newReadyTasks = [...state.readyTasks];
  let newRunningTasks = [...state.runningTasks];
  let newFailedTasks = [...state.failedTasks];
  
  for (const task of definition.tasks) {
    const existingState = newTaskStates[task.id];
    
    // Skip if already in terminal state
    if (existingState?.status === "completed" || 
        existingState?.status === "failed" ||
        existingState?.status === "cancelled") {
      continue;
    }
    
    // For tasks that were running when daemon crashed, reclassify deterministically
    if (existingState?.status === "running") {
      // Check if task was interrupted
      // If task has remaining retries, put back to ready
      const taskDef = definition.tasks.find(t => t.id === task.id);
      if (taskDef) {
        const maxRetries = taskDef.maxRetries ?? 0;
        if (existingState.attemptCount < maxRetries) {
          // Has retries remaining - put back to pending for retry
          newTaskStates[task.id] = {
            ...existingState,
            status: "pending",
            lastAttemptAt: now
          };
          // Remove from running
          newRunningTasks = newRunningTasks.filter(id => id !== task.id);
          // Add back to ready
          if (!newReadyTasks.includes(task.id)) {
            newReadyTasks = [...newReadyTasks, task.id];
          }
        } else {
          // No retries remaining - mark as failed
          newTaskStates[task.id] = {
            ...existingState,
            status: "failed",
            completedAt: now,
            error: { message: "Task interrupted by restart" }
          };
          newRunningTasks = newRunningTasks.filter(id => id !== task.id);
          newFailedTasks = [...newFailedTasks, task.id];
        }
      }
    }
    
    // For pending tasks, check if their deps are now met
    if (existingState?.status === "pending") {
      const depsMet = task.deps.every(dep => completedOrFailed.has(dep));
      if (depsMet && !newReadyTasks.includes(task.id)) {
        newReadyTasks = [...newReadyTasks, task.id];
      }
    }
  }
  
  return {
    ...state,
    taskStates: newTaskStates,
    readyTasks: newReadyTasks,
    runningTasks: newRunningTasks,
    failedTasks: newFailedTasks,
    updatedAt: now
  };
}

/**
 * Create and persist a new workflow
 */
export async function createWorkflow(
  definition: WorkflowDefinition,
  options?: { persistDefinition?: boolean }
): Promise<WorkflowState> {
  // Initialize state from definition
  const state = initializeWorkflowState(definition);
  
  // Save state
  await saveState(state);
  
  // Optionally save definition for reconstruction
  if (options?.persistDefinition !== false) {
    await saveDefinition(definition);
  }
  
  return state;
}

/**
 * Delete a workflow and its state
 */
export async function deleteWorkflow(workflowId: string): Promise<void> {
  const path = getWorkflowPath(workflowId);
  
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
    // Already gone
  }
  
  // Also remove from definitions if present (serialized through write queue)
  await enqueueDefinitionWrite(async () => {
    const defPath = getDefinitionsPath();
    try {
      const content = await readFile(defPath, { encoding: "utf-8" });
      const definitions = JSON.parse(content) as Record<string, WorkflowDefinition>;
      delete definitions[workflowId];

      const tempPath = `${defPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      await writeFile(tempPath, JSON.stringify(definitions, null, 2), { encoding: "utf-8", flag: "w" });

      try {
        await rename(tempPath, defPath);
      } catch {
        try {
          await unlink(tempPath);
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore - definition might not exist
    }
  });
}

/**
 * Get workflow stats (for telemetry)
 */
export async function getWorkflowStats(): Promise<{
  active: number;
  completed: number;
  failed: number;
  total: number;
}> {
  await ensureWorkflowsDir();
  
  let active = 0;
  let completed = 0;
  let failed = 0;
  let total = 0;
  
  try {
    const entries = await readdir(WORKFLOWS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.includes("definitions")) {
        continue;
      }
      
      total++;
      const state = await loadStateSafe(entry.replace(".json", ""));
      
      if (!state) continue;
      
      if (state.status === "completed") {
        completed++;
      } else if (state.status === "failed") {
        failed++;
      } else if (!isTerminalState(state.status)) {
        active++;
      }
    }
  } catch {
    // Directory might not exist yet
  }
  
  return { active, completed, failed, total };
}
