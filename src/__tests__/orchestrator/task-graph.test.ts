import { describe, test, expect, beforeEach } from "bun:test";
import {
  createWorkflow,
  validateWorkflow,
  getReadyTasks,
  advanceWorkflow,
  initializeWorkflowState,
  getTopologicalOrder,
  getParallelizableTasks
} from "../../orchestrator/task-graph";
import { WorkflowDefinition, WorkflowState } from "../../orchestrator/types";

describe("Task Graph Engine", () => {
  describe("createWorkflow", () => {
    test("creates workflow with generated ID if not provided", () => {
      const workflow = createWorkflow({
        type: "test",
        tasks: [{ id: "t1", type: "shell", deps: [], actionRef: "test" }]
      });
      
      expect(workflow.id).toMatch(/^wf-\d+-[a-z0-9]+$/);
      expect(workflow.type).toBe("test");
    });
    
    test("preserves provided ID", () => {
      const workflow = createWorkflow({
        id: "my-workflow",
        type: "test",
        tasks: []
      });
      
      expect(workflow.id).toBe("my-workflow");
    });
  });
  
  describe("validateWorkflow", () => {
    test("validates empty tasks array", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: []
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Workflow must have at least one task");
    });
    
    test("validates duplicate task IDs", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t1", type: "shell", deps: [], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate task ID: t1');
    });
    
    test("validates missing dependency references", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: ["nonexistent"], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Task "t1" depends on non-existent task "nonexistent"');
    });
    
    test("validates self-dependency", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Task "t1" cannot depend on itself');
    });
    
    test("validates negative retry delays", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { 
            id: "t1", 
            type: "shell", 
            deps: [], 
            actionRef: "test",
            retryPolicy: { initialDelayMs: -1 }
          }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Task "t1" has negative initialDelayMs');
    });
    
    test("validates invalid backoff multiplier", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { 
            id: "t1", 
            type: "shell", 
            deps: [], 
            actionRef: "test",
            retryPolicy: { backoffMultiplier: 0 }
          }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Task "t1" has invalid backoffMultiplier (must be > 0)');
    });
    
    test("returns warnings for tasks without actionRef", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
    
    test("passes valid workflow", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
  
  describe("cycle detection", () => {
    test("detects simple cycle", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: ["t2"], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("cycle"))).toBe(true);
    });
    
    test("detects indirect cycle", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: ["t2"], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t3"], actionRef: "test" },
          { id: "t3", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
    });
    
    test("allows valid DAG", () => {
      const workflow: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" },
          { id: "t3", type: "shell", deps: ["t1"], actionRef: "test" },
          { id: "t4", type: "shell", deps: ["t2", "t3"], actionRef: "test" }
        ]
      };
      
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });
  });
  
  describe("getReadyTasks", () => {
    test("returns tasks with no deps when workflow is new", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const state = initializeWorkflowState(definition);
      const ready = getReadyTasks(state, definition);
      
      expect(ready.map(t => t.id)).toEqual(["t1"]);
    });
    
    test("returns tasks whose deps are completed", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1", "t2"],
        runningTasks: [],
        completedTasks: ["t1"],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "completed", attemptCount: 1, completedAt: new Date().toISOString() },
          t2: { taskId: "t2", status: "pending", attemptCount: 0 }
        },
        results: {}
      };
      
      const ready = getReadyTasks(state, definition);
      expect(ready.map(t => t.id)).toEqual(["t2"]);
    });
    
    test("does not return tasks with unmet dependencies", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1", "t2"],
        runningTasks: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "pending", attemptCount: 0 },
          t2: { taskId: "t2", status: "pending", attemptCount: 0 }
        },
        results: {}
      };
      
      const ready = getReadyTasks(state, definition);
      expect(ready.map(t => t.id)).toEqual(["t1"]);
    });
  });
  
  describe("advanceWorkflow", () => {
    test("marks task as completed on success", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1"],
        runningTasks: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "ready", attemptCount: 0 }
        },
        results: {}
      };
      
      const newState = advanceWorkflow(state, definition, "t1", { success: true, result: "done" });
      
      expect(newState.taskStates.t1.status).toBe("completed");
      expect(newState.completedTasks).toContain("t1");
      expect(newState.results.t1).toBe("done");
    });
    
    test("schedules retry on retryable failure", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { 
            id: "t1", 
            type: "shell", 
            deps: [], 
            actionRef: "test",
            onError: "retry_task",
            maxRetries: 3
          }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1"],
        runningTasks: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "ready", attemptCount: 0 }
        },
        results: {}
      };
      
      const newState = advanceWorkflow(state, definition, "t1", { 
        success: false, 
        error: { message: "failed" } 
      });
      
      expect(newState.taskStates.t1.status).toBe("pending");
      expect(newState.taskStates.t1.attemptCount).toBe(1);
      expect(newState.taskStates.t1.nextRetryAt).toBeDefined();
    });
    
    test("fails workflow on non-retryable failure", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { 
            id: "t1", 
            type: "shell", 
            deps: [], 
            actionRef: "test",
            onError: "fail_workflow",
            maxRetries: 0
          }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1"],
        runningTasks: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "ready", attemptCount: 0 }
        },
        results: {}
      };
      
      const newState = advanceWorkflow(state, definition, "t1", { 
        success: false, 
        error: { message: "failed" } 
      });
      
      expect(newState.taskStates.t1.status).toBe("failed");
      expect(newState.status).toBe("failed");
      expect(newState.failedTasks).toContain("t1");
    });
    
    test("continues workflow on continue error behavior", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { 
            id: "t1", 
            type: "shell", 
            deps: [], 
            actionRef: "test",
            onError: "continue"
          }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1"],
        runningTasks: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "ready", attemptCount: 0 }
        },
        results: {}
      };
      
      const newState = advanceWorkflow(state, definition, "t1", { 
        success: false, 
        error: { message: "failed" } 
      });
      
      // With onError: continue, the task is marked completed even though it failed
      expect(newState.taskStates.t1.status).toBe("completed");
      expect(newState.status).toBe("running");
    });
    
    test("fails workflow when max retries exceeded", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { 
            id: "t1", 
            type: "shell", 
            deps: [], 
            actionRef: "test",
            onError: "retry_task",
            maxRetries: 2
          }
        ]
      };
      
      const state: WorkflowState = {
        workflowId: "test",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        readyTasks: ["t1"],
        runningTasks: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          t1: { taskId: "t1", status: "ready", attemptCount: 2 } // Already at max
        },
        results: {}
      };
      
      const newState = advanceWorkflow(state, definition, "t1", { 
        success: false, 
        error: { message: "failed" } 
      });
      
      expect(newState.taskStates.t1.status).toBe("failed");
      expect(newState.status).toBe("failed");
    });
  });
  
  describe("initializeWorkflowState", () => {
    test("marks tasks with no deps as ready", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" }
        ]
      };
      
      const state = initializeWorkflowState(definition);
      
      expect(state.readyTasks).toEqual(["t1"]);
      expect(state.taskStates.t1.status).toBe("ready");
      expect(state.taskStates.t2.status).toBe("pending");
    });
    
    test("initializes all task states", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: [], actionRef: "test" }
        ]
      };
      
      const state = initializeWorkflowState(definition);
      
      expect(Object.keys(state.taskStates)).toHaveLength(2);
      expect(state.taskStates.t1.attemptCount).toBe(0);
      expect(state.taskStates.t2.attemptCount).toBe(0);
    });
  });
  
  describe("getTopologicalOrder", () => {
    test("returns tasks in dependency order", () => {
      const tasks = [
        { id: "t1", type: "shell", deps: [], actionRef: "test" },
        { id: "t2", type: "shell", deps: ["t1"], actionRef: "test" },
        { id: "t3", type: "shell", deps: ["t1"], actionRef: "test" },
        { id: "t4", type: "shell", deps: ["t2", "t3"], actionRef: "test" }
      ];
      
      const order = getTopologicalOrder(tasks);
      
      // t1 should come before t2 and t3
      const t1Idx = order.findIndex(t => t.id === "t1");
      const t2Idx = order.findIndex(t => t.id === "t2");
      const t3Idx = order.findIndex(t => t.id === "t3");
      const t4Idx = order.findIndex(t => t.id === "t4");
      
      expect(t1Idx).toBeLessThan(t2Idx);
      expect(t1Idx).toBeLessThan(t3Idx);
      expect(t2Idx).toBeLessThan(t4Idx);
      expect(t3Idx).toBeLessThan(t4Idx);
    });
  });
  
  describe("getParallelizableTasks", () => {
    test("limits parallel tasks to maxParallel", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test" },
          { id: "t2", type: "shell", deps: [], actionRef: "test" },
          { id: "t3", type: "shell", deps: [], actionRef: "test" },
          { id: "t4", type: "shell", deps: [], actionRef: "test" },
          { id: "t5", type: "shell", deps: [], actionRef: "test" }
        ]
      };
      
      const state = initializeWorkflowState(definition);
      const parallel = getParallelizableTasks(definition.tasks, state, 2);
      
      expect(parallel.length).toBeLessThanOrEqual(2);
    });
    
    test("respects concurrency keys", () => {
      const definition: WorkflowDefinition = {
        id: "test",
        type: "test",
        tasks: [
          { id: "t1", type: "shell", deps: [], actionRef: "test", concurrencyKey: "same-resource" },
          { id: "t2", type: "shell", deps: [], actionRef: "test", concurrencyKey: "same-resource" },
          { id: "t3", type: "shell", deps: [], actionRef: "test", concurrencyKey: "different" }
        ]
      };
      
      const state = initializeWorkflowState(definition);
      const parallel = getParallelizableTasks(definition.tasks, state, 4);
      
      // Should select at most 2 tasks (one per concurrency key)
      expect(parallel.length).toBeLessThanOrEqual(2);
    });
  });
});
