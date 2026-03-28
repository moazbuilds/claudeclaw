/**
 * Workflow Executor
 * 
 * Executes ready tasks through registered handlers, persists transitions,
 * and applies policy/governance checks to workflow execution.
 */

import { WorkflowDefinition, WorkflowState, TaskDefinition, ExecutionContext } from "./types.ts";
import { getReadyTasks, advanceWorkflow, getParallelizableTasks } from "./task-graph.ts";
import { saveState, loadState, loadDefinition, rebuildExecutionView } from "./workflow-state.ts";
import { shouldBlockScheduling } from "../escalation";

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

// In-memory registry (would be dependency-injected in production)
let handlerRegistry: HandlerRegistry = {
  actions: {},
  compensations: {}
};

// Configuration
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
  if (await shouldBlockScheduling()) {
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
  
  // Execute each task
  let currentState = rebuiltState;
  
  for (const task of tasksToRun) {
    // Mark task as running
    currentState = {
      ...currentState,
      runningTasks: [...currentState.runningTasks.filter(id => id !== task.id), task.id],
      readyTasks: currentState.readyTasks.filter(id => id !== task.id),
      taskStates: {
        ...currentState.taskStates,
        [task.id]: {
          ...currentState.taskStates[task.id],
          status: "running",
          lastAttemptAt: new Date().toISOString()
        }
      },
      updatedAt: new Date().toISOString()
    };
    
    // Persist running state
    await saveState(currentState);
    
    // Execute governance checks
    const context: ExecutionContext = {
      workflowId: currentState.workflowId,
      taskId: task.id,
      sessionId: currentState.sessionId,
      claudeSessionId: currentState.claudeSessionId,
      channelId: currentState.channelId,
      threadId: currentState.threadId,
      input: task.input,
      previousResults: currentState.results
    };
    
    const governanceResult = await checkGovernance(task, context);
    
    if (!governanceResult.allowed) {
      // Task blocked by governance - treat as failure
      currentState = advanceWorkflow(currentState, definition, task.id, {
        success: false,
        error: {
          type: governanceResult.blockedBy || "GovernanceBlocked",
          message: governanceResult.reason || "Task blocked by governance policy"
        }
      });
      await saveState(currentState);
      continue;
    }
    
    // Execute the task
    const result = await executeTask(task, currentState, definition);
    
    // Advance workflow based on result
    currentState = advanceWorkflow(currentState, definition, task.id, result);
    
    // Handle orchestration failure escalation
    if (result.error && currentState.status === "failed") {
      try {
        const { handleOrchestrationFailure } = await import("../escalation");
        await handleOrchestrationFailure(currentState.workflowId, result.error.message);
      } catch (escalationError) {
        console.error("[escalation] Failed to send orchestration failure notification:", escalationError);
      }
    }
    
    // Persist updated state
    await saveState(currentState);
    
    // If workflow reached terminal state, stop
    if (currentState.status === "completed" || currentState.status === "failed") {
      break;
    }
  }
  
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
  if (await shouldBlockScheduling()) {
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
  
  const cancelledState: WorkflowState = {
    ...state,
    status: "cancelled",
    completedAt: now,
    updatedAt: now,
    readyTasks: [],
    runningTasks: [],
    cancelledTasks: cancelledTasks,
    taskStates: {
      ...state.taskStates
    }
  };
  
  // Mark each cancelled task
  for (const taskId of cancelledTasks) {
    cancelledState.taskStates[taskId] = {
      ...cancelledState.taskStates[taskId],
      status: "cancelled",
      completedAt: now
    };
  }
  
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
