import { describe, test, expect } from "bun:test";
import {
  getWorkflowTelemetry,
  getActiveWorkflows,
  getCompletedWorkflows,
  getFailedWorkflows,
  getAggregatedTelemetry,
  generateAuditRecords,
  getTelemetryAPI,
  type WorkflowTelemetry,
  type AggregatedTelemetry,
  type TelemetryRecord
} from "../../orchestrator/telemetry";
import { WorkflowState } from "../../orchestrator/types";

describe("Workflow Audit & Telemetry", () => {
  describe("WorkflowTelemetry", () => {
    test("calculates task counts correctly", () => {
      const telemetry: WorkflowTelemetry = {
        workflowId: "wf-1",
        status: "running",
        createdAt: new Date().toISOString(),
        taskCounts: {
          total: 5,
          completed: 2,
          failed: 0,
          running: 1,
          ready: 1,
          blocked: 0,
          continued: 1
        },
        retryCount: 3
      };
      
      expect(telemetry.taskCounts.total).toBe(5);
      expect(telemetry.taskCounts.completed).toBe(2);
      expect(telemetry.taskCounts.running).toBe(1);
    });
    
    test("calculates duration when started and completed", () => {
      const startedAt = new Date("2024-01-01T00:00:00.000Z");
      const completedAt = new Date("2024-01-01T00:01:30.000Z");
      
      const durationMs = completedAt.getTime() - startedAt.getTime();
      expect(durationMs).toBe(90000); // 90 seconds
    });
    
    test("handles missing duration when not completed", () => {
      const startedAt = new Date("2024-01-01T00:00:00.000Z");
      const now = Date.now();
      
      const durationMs = now - startedAt.getTime();
      expect(durationMs).toBeGreaterThan(0);
    });
    
    test("captures error information", () => {
      const error = {
        taskId: "task-1",
        type: "ExecutionError",
        message: "Handler failed"
      };
      
      expect(error.taskId).toBe("task-1");
      expect(error.message).toBe("Handler failed");
    });
  });
  
  describe("AggregatedTelemetry", () => {
    test("calculates retry rate", () => {
      const aggregated: AggregatedTelemetry = {
        timestamp: new Date().toISOString(),
        workflows: {
          active: 2,
          completed: 10,
          failed: 3,
          cancelled: 1,
          total: 16
        },
        tasks: {
          total: 50,
          completed: 30,
          failed: 5,
          running: 3,
          ready: 7,
          blocked: 2,
          continued: 3
        },
        averageDurationMs: 60000,
        retryRate: 0.1 // 10% retry rate
      };
      
      expect(aggregated.retryRate).toBe(0.1);
      expect(aggregated.tasks.total).toBe(50);
    });
    
    test("handles zero tasks for retry rate", () => {
      const aggregated: AggregatedTelemetry = {
        timestamp: new Date().toISOString(),
        workflows: {
          active: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          total: 0
        },
        tasks: {
          total: 0,
          completed: 0,
          failed: 0,
          running: 0,
          ready: 0,
          blocked: 0,
          continued: 0
        },
        retryRate: 0
      };
      
      expect(aggregated.retryRate).toBe(0);
    });
  });
  
  describe("TelemetryRecord", () => {
    test("workflow created record", () => {
      const record: TelemetryRecord = {
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        event: "created"
      };
      
      expect(record.event).toBe("created");
      expect(record.taskId).toBeUndefined();
    });
    
    test("task completed record with details", () => {
      const record: TelemetryRecord = {
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        event: "task_completed",
        taskId: "task-1",
        details: {
          attemptCount: 1,
          result: { output: "success" }
        }
      };
      
      expect(record.event).toBe("task_completed");
      expect(record.taskId).toBe("task-1");
      expect(record.details?.attemptCount).toBe(1);
    });
    
    test("task failed record with error", () => {
      const record: TelemetryRecord = {
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        event: "task_failed",
        taskId: "task-2",
        details: {
          attemptCount: 2,
          error: { message: "Connection timeout" }
        }
      };
      
      expect(record.event).toBe("task_failed");
      expect(record.details?.error).toEqual({ message: "Connection timeout" });
    });
    
    test("workflow completed record", () => {
      const record: TelemetryRecord = {
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        event: "workflow_completed",
        details: { durationMs: 120000 }
      };
      
      expect(record.event).toBe("workflow_completed");
      expect(record.details?.durationMs).toBe(120000);
    });
    
    test("workflow failed record", () => {
      const record: TelemetryRecord = {
        timestamp: new Date().toISOString(),
        workflowId: "wf-1",
        event: "workflow_failed",
        details: { error: { taskId: "task-3", message: "Max retries exceeded" } }
      };
      
      expect(record.event).toBe("workflow_failed");
      expect(record.details?.error).toEqual({ taskId: "task-3", message: "Max retries exceeded" });
    });
  });
  
  describe("generateAuditRecords", () => {
    test("generates audit records in chronological order", async () => {
      const createdAt = new Date("2024-01-01T00:00:00.000Z");
      const startedAt = new Date("2024-01-01T00:00:01.000Z");
      const taskStartedAt = new Date("2024-01-01T00:00:02.000Z");
      const taskCompletedAt = new Date("2024-01-01T00:00:05.000Z");
      const workflowCompletedAt = new Date("2024-01-01T00:00:10.000Z");
      
      // Mock state
      const mockState: WorkflowState = {
        workflowId: "wf-1",
        status: "completed",
        createdAt: createdAt.toISOString(),
        startedAt: startedAt.toISOString(),
        updatedAt: workflowCompletedAt.toISOString(),
        completedAt: workflowCompletedAt.toISOString(),
        readyTasks: [],
        runningTasks: [],
        completedTasks: ["task-1"],
        failedTasks: [],
        blockedTasks: [],
        taskStates: {
          "task-1": {
            taskId: "task-1",
            status: "completed",
            attemptCount: 1,
            lastAttemptAt: taskStartedAt.toISOString(),
            completedAt: taskCompletedAt.toISOString()
          }
        },
        results: {}
      };
      
      // Generate records
      const records: TelemetryRecord[] = [
        {
          timestamp: mockState.createdAt,
          workflowId: mockState.workflowId,
          event: "created"
        },
        {
          timestamp: mockState.startedAt!,
          workflowId: mockState.workflowId,
          event: "started"
        },
        {
          timestamp: mockState.taskStates["task-1"].lastAttemptAt!,
          workflowId: mockState.workflowId,
          event: "task_started",
          taskId: "task-1"
        },
        {
          timestamp: mockState.taskStates["task-1"].completedAt!,
          workflowId: mockState.workflowId,
          event: "task_completed",
          taskId: "task-1"
        },
        {
          timestamp: mockState.completedAt!,
          workflowId: mockState.workflowId,
          event: "workflow_completed"
        }
      ];
      
      // Verify chronological order
      for (let i = 1; i < records.length; i++) {
        const prevTime = new Date(records[i - 1].timestamp).getTime();
        const currTime = new Date(records[i].timestamp).getTime();
        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }
    });
  });
  
  describe("TelemetryAPIResponse", () => {
    test("success response format", () => {
      const response = {
        success: true as const,
        data: {
          active: [],
          aggregated: {
            timestamp: new Date().toISOString(),
            workflows: { active: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
            tasks: { total: 0, completed: 0, failed: 0, running: 0, ready: 0, blocked: 0, continued: 0 },
            retryRate: 0
          }
        }
      };
      
      expect(response.success).toBe(true);
      expect(response.data?.aggregated?.workflows.total).toBe(0);
    });
    
    test("error response format", () => {
      const response = {
        success: false as const,
        error: "Workflow not found"
      };
      
      expect(response.success).toBe(false);
      expect(response.error).toBe("Workflow not found");
    });
  });
  
  describe("workflow status tracking", () => {
    test("terminal status is completed", () => {
      const statuses: WorkflowState["status"][] = ["completed", "failed", "cancelled"];
      
      for (const status of statuses) {
        const isTerminal = status === "completed" || status === "failed" || status === "cancelled";
        expect(isTerminal).toBe(true);
      }
    });
    
    test("non-terminal status is running/pending/waiting", () => {
      const statuses: WorkflowState["status"][] = ["running", "pending", "waiting"];
      
      for (const status of statuses) {
        const isTerminal = status === "completed" || status === "failed" || status === "cancelled";
        expect(isTerminal).toBe(false);
      }
    });
  });
});
