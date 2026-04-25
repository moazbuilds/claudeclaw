/**
 * Workflow Executor
 * 
 * Executes ready tasks through registered handlers, persists transitions,
 * and applies policy/governance checks to workflow execution.
 */

import { WorkflowDefinition, WorkflowState, TaskDefinition, ExecutionContext } from "./types.ts";
import { getReadyTasks, advanceWorkflow, getParallelizableTasks } from "./task-graph.ts";
import { saveState, loadState, loadDefinition, rebuildExecutionView } from "./workflow-state.ts";
import { OrchestratorGovernanceAdapter } from "./governance-adapter";

/**
 * Lazy loader for the escalation module.
 * The module lives in a separate PR and may not be available on this branch.
 * Falls back to a no-op (never block) when the module is missing.
 */
let _shouldBlockScheduling: (() => boolean) | null = null;
async function getShouldBlockScheduling(): Promise<() => boolean> {
  if (_shouldBlockScheduling) return _shouldBlockScheduling;
  try {
    const mod = await import("../escalation");
    _shouldBlockScheduling = mod.shouldBlockScheduling;
    return _shouldBlockScheduling;
  } catch {
    // Escalation module not available - never block
    _shouldBlockScheduling = () => false;
    return _shouldBlockScheduling;
  }
}

/**
 * Action handler registry - maps actionRef to handler functions
 */
export type ActionHandler = (input: Record<string, unknown>, context: ExecutionContext) => Promise<unknown>;
export type CompensationHandler = (input: Record<string, unknown>, context: ExecutionContext) => Promise<unknown>;

interface HandlerRegistry {
  actions: Record<string, ActionHandler>;
  compensations: Record<string, CompensationHandler>;
}

/**
 * Governance check result
 */
export interface GovernanceCheck {
  allowed: boolean;
  reason?: string;
  blockedBy?: string;
}

/**
 * Executor configuration
 */
export interface ExecutorConfig {
  maxParallel?: number;
  enableGovernance?: boolean;
  enableBudget?: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ExecutorConfig = {
  maxParallel: 4,
  enableGovernance: true,
  enableBudget: true
};

// NOTE: These are process-wide singletons. Not safe for concurrent use
// with different configurations. Tests must reset via beforeEach.
let handlerRegistry: HandlerRegistry = {
  actions: {},
  compensations: {}
};

// Process-wide config singleton (see note above on handlerRegistry)
let config: ExecutorConfig = { ...DEFAULT_CONFIG };

/**
 * Register action handlers
 */
export function registerHandlers(handlers: HandlerRegistry): void {
  handlerRegistry = handlers;
}

/**
 * Update executor configuration
 */
export function setConfig(newConfig: Partial<ExecutorConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Governance interface - implemented by Phase 3/4 integration
 */
export interface GovernanceClient {
  checkPolicy(channelId: string, action: string): Promise<GovernanceCheck>;
  checkBudget(sessionId: string, action: string): Promise<GovernanceCheck>;
}

let governanceClient: GovernanceClient | null = null;

/**
 * Set governance client for policy/budget checks
 */
export function setGovernanceClient(client: GovernanceClient | null): void {
  governanceClient = client;
}

/**
 * Execute governance checks for a task
 */
async function checkGovernance(task: TaskDefinition, context: ExecutionContext): Promise<GovernanceCheck> {
  if (!config.enableGovernance || !governanceClient) {
    return { allowed: true };
  }
  
  // Check policy
  if (task.actionRef) {
    const policyCheck = await governanceClient.checkPolicy(
      context.channelId || "",
      task.actionRef
    );
    if (!policyCheck.allowed) {
      return policyCheck;
    }
  }
  
  // Check budget
  if (config.enableBudget && context.sessionId) {
    const budgetCheck = await governanceClient.checkBudget(
      context.sessionId,
      task.actionRef
    );
    if (!budgetCheck.allowed) {
      return budgetCheck;
    }
  }
  
  return { allowed: true };
}

/**
 * Execute a single task through its registered handler
 */
async function executeTask(
  task: TaskDefinition,
  state: WorkflowState,
  definition: WorkflowDefinition
): Promise<{ success: boolean; result?: unknown; error?: { type?: string; message: string } }> {
  const handler = handlerRegistry.actions[task.actionRef];
  
  if (!handler) {
    return {
      success: false,
      error: { type: "HandlerNotFound", message: `No handler registered for action: ${task.actionRef}` }
    };
  }
  
  const context: ExecutionContext = {
    workflowId: state.workflowId,
    taskId: task.id,
    sessionId: state.sessionId,
    claudeSessionId: state.claudeSessionId,
    channelId: state.channelId,
    threadId: state.threadId,
    input: task.input,
    previousResults: state.results
  };
  
  try {
    const result = await handler(task.input || {}, context);
    return { success: true, result };
  } catch (err) {
    const error = err instanceof Error 
      ? { type: "ExecutionError", message: err.message }
      : { type: "UnknownError", message: String(err) };
    return { success: false, error };
  }
}

/**
 * Execute ready tasks for a workflow
 */
export async function executeReadyTasks(workflowId: string): Promise<WorkflowState | null> {
  // Load workflow state and definition
  const state = await loadState(workflowId);
  if (!state) {
    return null;
  }
  
  const definition = await loadDefinition(workflowId);
  if (!definition) {
    // Cannot execute without definition
    return null;
  }
  
  // Rebuild execution view in case we restarted mid-workflow
  const rebuiltState = rebuildExecutionView(state, definition);
  
  // Check if scheduling is paused - skip task execution when paused
  const shouldBlock = await getShouldBlockScheduling();
  if (shouldBlock()) {
    return rebuiltState;
  }

  // Get tasks ready for execution
  const readyTasks = getReadyTasks(rebuiltState, definition);
  
  // Apply bounded parallelism
  const parallelizable = getParallelizableTasks(
    readyTasks,
    rebuiltState,
    config.maxParallel || 4
  );
  
  // Filter to only tasks that should actually run (ready status)
  const tasksToRun = parallelizable.filter(t => {
    const taskState = rebuiltState.taskStates[t.id];
    return taskState && (taskState.status === "ready" || taskState.status === "pending");
  });
  
  if (tasksToRun.length === 0) {
    return rebuiltState;
  }
  
  // Mark all tasks as running before parallel execution
  let currentState = rebuiltState;
  const now = new Date().toISOString();

  for (const task of tasksToRun) {
    currentState = {
      ...currentState,
      runningTasks: [...currentState.runningTasks.filter(id => id !== task.id), task.id],
      readyTasks: currentState.readyTasks.filter(id => id !== task.id),
      taskStates: {
        ...currentState.taskStates,
        [task.id]: {
          ...currentState.taskStates[task.id],
          status: "running",
          lastAttemptAt: now
        }
      },
      updatedAt: now
    };
  }

  // Persist running state for all tasks
  await saveState(currentState);

  // Execute a single task: governance check, run handler, return result
  async function executeAndAdvanceTask(
    task: TaskDefinition,
    snapshotState: WorkflowState,
    def: WorkflowDefinition
  ): Promise<{ taskId: string; result: { success: boolean; result?: unknown; error?: { type?: string; message: string } } }> {
    const context: ExecutionContext = {
      workflowId: snapshotState.workflowId,
      taskId: task.id,
      sessionId: snapshotState.sessionId,
      claudeSessionId: snapshotState.claudeSessionId,
      channelId: snapshotState.channelId,
      threadId: snapshotState.threadId,
      input: task.input,
      previousResults: snapshotState.results
    };

    const governanceResult = await checkGovernance(task, context);

    if (!governanceResult.allowed) {
      return {
        taskId: task.id,
        result: {
          success: false,
          error: {
            type: governanceResult.blockedBy || "GovernanceBlocked",
            message: governanceResult.reason || "Task blocked by governance policy"
          }
        }
      };
    }

    const result = await executeTask(task, snapshotState, def);
    return { taskId: task.id, result };
  }

  // Execute all tasks in parallel.
  // NOTE: Tasks executing in parallel receive the same state snapshot.
  // previousResults from concurrent tasks will not be visible to each other.
  // This is acceptable because parallelized tasks are independent (no shared dependencies).
  // Tasks sharing a concurrencyKey are already serialized by getParallelizableTasks.
  const settled = await Promise.allSettled(
    tasksToRun.map(task => executeAndAdvanceTask(task, currentState, definition))
  );

  // Merge results back into state sequentially
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { taskId, result } = outcome.value;
      currentState = advanceWorkflow(currentState, definition, taskId, result);

      // Handle orchestration failure escalation
      if (result.error && currentState.status === "failed") {
        try {
          const escalationMod = await import("../escalation");
          if (escalationMod.handleOrchestrationFailure) {
            await escalationMod.handleOrchestrationFailure(currentState.workflowId, result.error.message);
          }
        } catch {
          // Escalation module not available on this branch - skip notification
        }
      }
    } else {
      // Promise rejected (unexpected) - should not happen since executeTask catches errors
      console.error("[executor] Unexpected task rejection:", outcome.reason);
    }

    // If workflow reached terminal state, stop processing remaining results
    if (currentState.status === "completed" || currentState.status === "failed") {
      break;
    }
  }

  // Persist final state
  await saveState(currentState);

  return currentState;
}

/**
 * Start executing a workflow
 */
export async function executeWorkflow(workflowId: string): Promise<WorkflowState | null> {
  let state = await loadState(workflowId);
  if (!state) {
    return null;
  }
  
  // Check if scheduling is paused - skip workflow execution when paused
  const shouldBlock = await getShouldBlockScheduling();
  if (shouldBlock()) {
    return state;
  }
  
  // Mark as running if pending
  if (state.status === "pending") {
    state = {
      ...state,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveState(state);
  }
  
  // Execute ready tasks
  return await executeReadyTasks(workflowId);
}

/**
 * Resume a workflow after restart or pause
 */
export async function resumeWorkflow(workflowId: string): Promise<WorkflowState | null> {
  const state = await loadState(workflowId);
  if (!state) {
    return null;
  }
  
  // If workflow is in a terminal state, nothing to resume
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    return state;
  }
  
  // Rebuild execution view to handle restart reclassification
  const definition = await loadDefinition(workflowId);
  if (!definition) {
    return null;
  }
  
  const rebuiltState = rebuildExecutionView(state, definition);
  
  // If status was waiting/pending but we have ready tasks now, resume running
  let currentState = rebuiltState;
  if (currentState.status === "waiting" || currentState.status === "pending") {
    currentState = {
      ...currentState,
      status: "running",
      startedAt: currentState.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveState(currentState);
  }
  
  // Execute ready tasks
  return await executeReadyTasks(workflowId);
}

/**
 * Cancel a workflow
 */
export async function cancelWorkflow(workflowId: string): Promise<WorkflowState | null> {
  const state = await loadState(workflowId);
  if (!state) {
    return null;
  }
  
  // If already terminal, return as-is
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    return state;
  }
  
  const now = new Date().toISOString();
  
  // Mark all ready/running tasks as cancelled
  const cancelledTasks = [...state.readyTasks, ...state.runningTasks];

  // Build updated task states immutably before constructing final state
  const updatedTaskStates = { ...state.taskStates };
  for (const taskId of cancelledTasks) {
    updatedTaskStates[taskId] = {
      ...updatedTaskStates[taskId],
      status: "cancelled",
      completedAt: now
    };
  }

  const cancelledState: WorkflowState = {
    ...state,
    status: "cancelled",
    completedAt: now,
    updatedAt: now,
    readyTasks: [],
    runningTasks: [],
    cancelledTasks,
    taskStates: updatedTaskStates,
  };
  
  await saveState(cancelledState);
  return cancelledState;
}

/**
 * Execute compensation for a task
 */
export async function executeCompensation(
  task: TaskDefinition,
  state: WorkflowState,
  _definition: WorkflowDefinition
): Promise<{ success: boolean; error?: { message: string } }> {
  if (!task.compensationRef) {
    return { success: true }; // No compensation needed
  }
  
  const handler = handlerRegistry.compensations[task.compensationRef];
  
  if (!handler) {
    return {
      success: false,
      error: { message: `No compensation handler registered for: ${task.compensationRef}` }
    };
  }
  
  const context: ExecutionContext = {
    workflowId: state.workflowId,
    taskId: task.id,
    sessionId: state.sessionId,
    claudeSessionId: state.claudeSessionId,
    channelId: state.channelId,
    threadId: state.threadId,
    input: task.input,
    previousResults: state.results
  };
  
  try {
    await handler(task.input || {}, context);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: { message: err instanceof Error ? err.message : String(err) }
    };
  }
}

/**
 * Run a workflow to completion (for testing or fire-and-forget scenarios)
 */
export async function runWorkflowToCompletion(
  workflowId: string,
  options?: { maxIterations?: number; pollIntervalMs?: number }
): Promise<WorkflowState | null> {
  const maxIterations = options?.maxIterations || 100;
  const pollIntervalMs = options?.pollIntervalMs || 100;
  
  for (let i = 0; i < maxIterations; i++) {
    const state = await executeWorkflow(workflowId);
    
    if (!state) {
      return null;
    }
    
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      return state;
    }
    
    // Wait before next iteration
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  
  // Max iterations reached
  return await loadState(workflowId);
}
