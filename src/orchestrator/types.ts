/**
 * Workflow Orchestration Types
 * 
 * Core type definitions for workflow definitions, task definitions,
 * workflow state, and task runtime state.
 */

/**
 * Workflow definition - the static blueprint for a workflow
 */
export interface WorkflowDefinition {
  id: string;
  type: string;
  version?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
  tasks: TaskDefinition[];
}

/**
 * Task definition - the static blueprint for a task within a workflow
 */
export interface TaskDefinition {
  id: string;
  type: string;
  deps: string[];
  actionRef: string;
  input?: Record<string, unknown>;
  onError?: "fail_workflow" | "continue" | "retry_task";
  maxRetries?: number;
  retryPolicy?: RetryPolicy;
  compensationRef?: string;
  concurrencyKey?: string;
  idempotencyKey?: string;
}

/**
 * Retry policy for task execution
 */
export interface RetryPolicy {
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

/**
 * Workflow state - the mutable runtime state of a workflow
 */
export interface WorkflowState {
  workflowId: string;
  version?: string;
  status: WorkflowStatus;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  readyTasks: string[];
  runningTasks: string[];
  completedTasks: string[];
  failedTasks: string[];
  blockedTasks: string[];
  cancelledTasks?: string[];
  continuedTasks?: string[]; // Tasks that failed but workflow continued via onError: "continue"
  taskStates: Record<string, TaskRuntimeState>;
  results: Record<string, unknown>;
  error?: WorkflowError;
}

/**
 * Workflow status - terminal or active states
 */
export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

/**
 * Workflow-level error information
 */
export interface WorkflowError {
  taskId?: string;
  type?: string;
  message: string;
}

/**
 * Task runtime state - the mutable runtime state of a single task
 */
export interface TaskRuntimeState {
  taskId: string;
  status: TaskStatus;
  attemptCount: number;
  lastAttemptAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  result?: unknown;
  error?: TaskError;
}

/**
 * Task status - terminal or active states
 */
export type TaskStatus = 
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * Task-level error information
 */
export interface TaskError {
  type?: string;
  message: string;
}

/**
 * Validation result for workflow validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Handler registry for action/compensation references
 */
export type ActionHandler = (input: Record<string, unknown>, context: ExecutionContext) => Promise<unknown>;
export type CompensationHandler = (input: Record<string, unknown>, context: ExecutionContext) => Promise<unknown>;

export interface HandlerRegistry {
  actions: Record<string, ActionHandler>;
  compensations: Record<string, CompensationHandler>;
}

/**
 * Execution context passed to action handlers
 */
export interface ExecutionContext {
  workflowId: string;
  taskId: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  channelId?: string;
  threadId?: string;
  input?: Record<string, unknown>;
  previousResults?: Record<string, unknown>;
}
