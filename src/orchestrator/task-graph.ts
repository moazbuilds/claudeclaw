/**
 * Task Graph Engine
 * 
 * Defines graph validation and progression logic for workflow task graphs.
 * Provides cycle detection, topological sorting, and ready-task identification.
 */

import { WorkflowDefinition, TaskDefinition, WorkflowState, TaskRuntimeState, ValidationResult } from "./types.ts";

/**
 * Cycle detection result with path information for debugging
 */
interface CycleInfo {
  hasCycle: boolean;
  path?: string[];
}

/**
 * Task with resolved dependencies for execution planning
 */
interface ResolvedTask {
  task: TaskDefinition;
  unmetDeps: Set<string>;
  ready: boolean;
}

/**
 * Create a workflow definition with validation
 */
export function createWorkflow(definition: Omit<WorkflowDefinition, "id">): WorkflowDefinition {
  const id = definition.id || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return { ...definition, id } as WorkflowDefinition;
}

/**
 * Validate a workflow definition
 * Checks for cycles, missing dependencies, and invalid references
 */
export function validateWorkflow(definition: WorkflowDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check for empty tasks
  if (!definition.tasks || definition.tasks.length === 0) {
    errors.push("Workflow must have at least one task");
    return { valid: false, errors, warnings };
  }
  
  // Build task ID set for quick lookup
  const taskIds = new Set(definition.tasks.map(t => t.id));
  
  // Check for duplicate task IDs
  const seenIds = new Set<string>();
  for (const task of definition.tasks) {
    if (seenIds.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    }
    seenIds.add(task.id);
  }
  
  // Validate each task
  for (const task of definition.tasks) {
    // Check dependency references exist
    for (const dep of task.deps) {
      if (!taskIds.has(dep)) {
        errors.push(`Task "${task.id}" depends on non-existent task "${dep}"`);
      }
      // Self-dependency check
      if (dep === task.id) {
        errors.push(`Task "${task.id}" cannot depend on itself`);
      }
    }
    
    // Validate retry policy if present
    if (task.retryPolicy) {
      if (task.retryPolicy.initialDelayMs !== undefined && task.retryPolicy.initialDelayMs < 0) {
        errors.push(`Task "${task.id}" has negative initialDelayMs`);
      }
      if (task.retryPolicy.maxDelayMs !== undefined && task.retryPolicy.maxDelayMs < 0) {
        errors.push(`Task "${task.id}" has negative maxDelayMs`);
      }
      if (task.retryPolicy.backoffMultiplier !== undefined && task.retryPolicy.backoffMultiplier <= 0) {
        errors.push(`Task "${task.id}" has invalid backoffMultiplier (must be > 0)`);
      }
    }
    
    // Warn about missing actionRef
    if (!task.actionRef && !task.compensationRef) {
      warnings.push(`Task "${task.id}" has no actionRef or compensationRef`);
    }
  }
  
  // Check for cycles using DFS
  const cycleInfo = detectCycle(definition.tasks);
  if (cycleInfo.hasCycle) {
    errors.push(`Workflow contains a cycle: ${cycleInfo.path?.join(" -> ")}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Detect cycles in the task graph using DFS
 */
function detectCycle(tasks: TaskDefinition[]): CycleInfo {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];
  
  function dfs(taskId: string): CycleInfo {
    if (inStack.has(taskId)) {
      // Found cycle - extract the cycle path
      const cycleStart = path.indexOf(taskId);
      const cyclePath = [...path.slice(cycleStart), taskId];
      return { hasCycle: true, path: cyclePath };
    }
    
    if (visited.has(taskId)) {
      return { hasCycle: false };
    }
    
    const task = taskMap.get(taskId);
    if (!task) {
      return { hasCycle: false };
    }
    
    visited.add(taskId);
    inStack.add(taskId);
    path.push(taskId);
    
    for (const dep of task.deps) {
      const result = dfs(dep);
      if (result.hasCycle) {
        return result;
      }
    }
    
    path.pop();
    inStack.delete(taskId);
    return { hasCycle: false };
  }
  
  // Start DFS from each unvisited task
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      const result = dfs(task.id);
      if (result.hasCycle) {
        return result;
      }
    }
  }
  
  return { hasCycle: false };
}

/**
 * Get tasks that are ready to execute based on current workflow state
 * A task is ready when:
 * - It has no unmet dependencies (all deps completed)
 * - It is not already running, completed, or failed
 */
export function getReadyTasks(state: WorkflowState, _definition: WorkflowDefinition): TaskDefinition[] {
  const ready: TaskDefinition[] = [];
  const definitionTasks = new Map(_definition.tasks.map(t => [t.id, t]));
  
  // Get set of completed task IDs (including continued tasks so dependents can proceed)
  const completedOrFailed = new Set([
    ...state.completedTasks,
    ...state.failedTasks,
    ...(state.continuedTasks || [])
  ]);
  
  for (const taskId of state.readyTasks) {
    const task = definitionTasks.get(taskId);
    if (!task) continue;
    
    // Check if task is actually ready (not already running/completed/failed)
    const taskState = state.taskStates[taskId];
    if (!taskState) continue;
    
    if (taskState.status === "ready" || taskState.status === "pending") {
      // Verify all dependencies are met
      const depsMet = task.deps.every(dep => completedOrFailed.has(dep));
      if (depsMet) {
        ready.push(task);
      }
    }
  }
  
  return ready;
}

/**
 * Advance workflow state based on task result
 * Updates task states and determines next ready tasks
 */
export function advanceWorkflow(
  state: WorkflowState,
  definition: WorkflowDefinition,
  taskId: string,
  result: { success: boolean; result?: unknown; error?: { type?: string; message: string } }
): WorkflowState {
  const now = new Date().toISOString();
  const taskIndex = definition.tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    throw new Error(`Task ${taskId} not found in workflow`);
  }
  
  const task = definition.tasks[taskIndex];
  const taskState = state.taskStates[taskId];
  
  // Clone state to avoid mutation
  const newState: WorkflowState = {
    ...state,
    taskStates: { ...state.taskStates },
    results: { ...state.results }
  };
  
  // Update task state
  if (taskState) {
    newState.taskStates[taskId] = {
      ...taskState,
      lastAttemptAt: now
    };
  }
  
  if (result.success) {
    // Task completed successfully
    newState.taskStates[taskId] = {
      ...newState.taskStates[taskId],
      status: "completed",
      completedAt: now,
      result: result.result,
      error: undefined
    };
    
    // Move from ready/running to completed
    newState.readyTasks = newState.readyTasks.filter(id => id !== taskId);
    newState.runningTasks = newState.runningTasks.filter(id => id !== taskId);
    if (!newState.completedTasks.includes(taskId)) {
      newState.completedTasks = [...newState.completedTasks, taskId];
    }
    
    // Store result
    newState.results[taskId] = result.result;
    
    // Find newly ready tasks
    const newlyReady = findNewlyReadyTasks(newState, definition, taskId);
    newState.readyTasks = [...newState.readyTasks, ...newlyReady];
    
  } else {
    // Task failed
    const currentAttempt = taskState?.attemptCount || 0;
    const maxRetries = task.maxRetries ?? 0;
    
    if (currentAttempt < maxRetries && task.onError === "retry_task") {
      // Schedule retry
      const retryDelay = calculateRetryDelay(currentAttempt, task.retryPolicy);
      newState.taskStates[taskId] = {
        ...newState.taskStates[taskId],
        status: "pending",
        attemptCount: currentAttempt + 1,
        nextRetryAt: new Date(Date.now() + retryDelay).toISOString(),
        error: result.error
      };
      
      // Remove from running, keep in readyTasks for retry
      newState.runningTasks = newState.runningTasks.filter(id => id !== taskId);
      
    } else if (task.onError === "continue") {
      // Continue despite failure - track in continuedTasks (not completedTasks)
      newState.taskStates[taskId] = {
        ...newState.taskStates[taskId],
        status: "completed",
        completedAt: now,
        error: result.error
      };
      
      newState.readyTasks = newState.readyTasks.filter(id => id !== taskId);
      newState.runningTasks = newState.runningTasks.filter(id => id !== taskId);
      if (!newState.continuedTasks?.includes(taskId)) {
        newState.continuedTasks = [...(newState.continuedTasks || []), taskId];
      }
      
      // Find newly ready tasks
      const newlyReady = findNewlyReadyTasks(newState, definition, taskId);
      newState.readyTasks = [...newState.readyTasks, ...newlyReady];
      
    } else {
      // fail_workflow or max retries exceeded
      newState.taskStates[taskId] = {
        ...newState.taskStates[taskId],
        status: "failed",
        completedAt: now,
        error: result.error
      };
      
      newState.readyTasks = newState.readyTasks.filter(id => id !== taskId);
      newState.runningTasks = newState.runningTasks.filter(id => id !== taskId);
      if (!newState.failedTasks.includes(taskId)) {
        newState.failedTasks = [...newState.failedTasks, taskId];
      }
      
      // Mark workflow as failed
      newState.status = "failed";
      newState.error = {
        taskId,
        type: result.error?.type,
        message: result.error?.message || "Task failed"
      };
      newState.completedAt = now;
    }
  }
  
  // Update workflow timestamps
  newState.updatedAt = now;
  
  // Check if workflow is complete (immutable: merge returned changes)
  const completion = checkWorkflowCompletion(newState, definition);
  if (completion) {
    return { ...newState, ...completion };
  }

  return newState;
}

/**
 * Find tasks that become ready after a task completes
 */
function findNewlyReadyTasks(state: WorkflowState, definition: WorkflowDefinition, completedTaskId: string): string[] {
  const newlyReady: string[] = [];
  // Tasks with deps satisfied: completed, failed, or continued (onError: continue)
  const completedOrFailed = new Set([
    ...state.completedTasks,
    ...state.failedTasks,
    ...(state.continuedTasks || [])
  ]);
  
  for (const task of definition.tasks) {
    // Skip if already has a state that isn't pending/ready
    const existingState = state.taskStates[task.id];
    if (existingState && existingState.status !== "pending" && existingState.status !== "blocked") {
      continue;
    }
    
    // Skip if already ready or running
    if (state.readyTasks.includes(task.id) || state.runningTasks.includes(task.id)) {
      continue;
    }
    
    // Check if all dependencies are met
    const depsMet = task.deps.every(dep => completedOrFailed.has(dep));
    if (depsMet) {
      // Check if task was previously blocked
      if (state.blockedTasks.includes(task.id)) {
        // Task was blocked, now ready
        newlyReady.push(task.id);
      } else if (!existingState || existingState.status === "pending") {
        // Task is new or was pending
        newlyReady.push(task.id);
      }
    }
  }
  
  return newlyReady;
}

/**
 * Calculate retry delay based on retry policy with exponential backoff
 */
function calculateRetryDelay(
  attemptCount: number,
  retryPolicy?: TaskDefinition["retryPolicy"]
): number {
  if (!retryPolicy) {
    return 1000; // Default 1 second
  }
  
  const initialDelay = retryPolicy.initialDelayMs ?? 1000;
  const maxDelay = retryPolicy.maxDelayMs ?? 60000;
  const multiplier = retryPolicy.backoffMultiplier ?? 2;
  
  const delay = initialDelay * Math.pow(multiplier, attemptCount);
  return Math.min(delay, maxDelay);
}

/**
 * Check if workflow is complete and return state changes
 * Returns a partial WorkflowState to merge, or null if no change needed.
 * Note: continuedTasks (onError: "continue") are not counted as terminal completion
 */
function checkWorkflowCompletion(state: WorkflowState, definition: WorkflowDefinition): Partial<WorkflowState> | null {
  const totalTasks = definition.tasks.length;
  const completedTasks = state.completedTasks.length;
  const failedTasks = state.failedTasks.length;
  const continuedTasks = state.continuedTasks?.length || 0;
  const pendingOrReady = state.readyTasks.length;
  const runningTasks = state.runningTasks.length;

  if (state.status === "failed" || state.status === "cancelled") {
    // Already in terminal state
    return null;
  }

  // Terminal count excludes continuedTasks - they don't cause failure but don't complete either
  const terminalCount = completedTasks + failedTasks;
  const nonTerminalRemaining = continuedTasks + pendingOrReady + runningTasks;

  if (terminalCount + nonTerminalRemaining === totalTasks) {
    // All tasks have finished in some way
    if (failedTasks > 0) {
      return {
        status: "failed",
        ...(!state.completedAt ? { completedAt: new Date().toISOString() } : {})
      };
    } else if (nonTerminalRemaining === 0) {
      // Everything completed with no failures and no remaining tasks
      return {
        status: "completed",
        ...(!state.completedAt ? { completedAt: new Date().toISOString() } : {})
      };
    }
    // If there are continued tasks still being tracked but no pending/running,
    // the workflow stays "running" - continued tasks don't cause completion
  } else if (pendingOrReady === 0 && runningTasks === 0 && terminalCount < totalTasks) {
    // No tasks ready or running but workflow not complete - this is an error
    // It means we have blocked tasks but no way to proceed
    return { status: "blocked" };
  }

  return null;
}

/**
 * Initialize workflow state from a definition
 */
export function initializeWorkflowState(definition: WorkflowDefinition): WorkflowState {
  const now = new Date().toISOString();
  
  // Find tasks with no dependencies - they are initially ready
  const readyTasks = definition.tasks
    .filter(t => t.deps.length === 0)
    .map(t => t.id);
  
  // Initialize task states
  const taskStates: Record<string, TaskRuntimeState> = {};
  for (const task of definition.tasks) {
    taskStates[task.id] = {
      taskId: task.id,
      status: readyTasks.includes(task.id) ? "ready" : "pending",
      attemptCount: 0
    };
  }
  
  return {
    workflowId: definition.id,
    version: definition.version,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    sessionId: definition.sessionId,
    claudeSessionId: definition.claudeSessionId,
    source: definition.source,
    channelId: definition.channelId,
    threadId: definition.threadId,
    readyTasks,
    runningTasks: [],
    completedTasks: [],
    failedTasks: [],
    blockedTasks: [],
    taskStates,
    results: {}
  };
}

/**
 * Get topological order of tasks for execution
 * Returns tasks in dependency order (parents before children)
 */
export function getTopologicalOrder(tasks: TaskDefinition[]): TaskDefinition[] {
  const result: TaskDefinition[] = [];
  const visited = new Set<string>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  
  function visit(taskId: string): void {
    if (visited.has(taskId)) return;
    
    const task = taskMap.get(taskId);
    if (!task) return;
    
    visited.add(taskId);
    
    // Visit all dependencies first
    for (const dep of task.deps) {
      visit(dep);
    }
    
    result.push(task);
  }
  
  // Visit all tasks
  for (const task of tasks) {
    visit(task.id);
  }
  
  return result;
}

/**
 * Determine which tasks can run in parallel (bounded parallelism)
 * Tasks are parallel-safe if they have no shared dependencies or dependents
 */
export function getParallelizableTasks(
  tasks: TaskDefinition[],
  state: WorkflowState,
  maxParallel: number = 4
): TaskDefinition[] {
  const readyTasks = getReadyTasks(state, { ...{ id: "temp" }, tasks } as WorkflowDefinition);
  
  // Filter to tasks that are actually runnable
  const runnable = readyTasks.filter(t => {
    const taskState = state.taskStates[t.id];
    return taskState && (taskState.status === "ready" || taskState.status === "pending");
  });
  
  // Check concurrency keys to prevent conflicts
  const concurrencyGroups = new Map<string, TaskDefinition[]>();
  for (const task of runnable) {
    const key = task.concurrencyKey || "default";
    if (!concurrencyGroups.has(key)) {
      concurrencyGroups.set(key, []);
    }
    concurrencyGroups.get(key)!.push(task);
  }
  
  // Select one task per concurrency group, up to maxParallel
  const selected: TaskDefinition[] = [];
  for (const [, group] of concurrencyGroups) {
    if (selected.length >= maxParallel) break;
    // Take the first task from each concurrency group
    selected.push(group[0]);
  }
  
  return selected.slice(0, maxParallel);
}
