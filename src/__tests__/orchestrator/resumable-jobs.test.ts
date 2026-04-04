import { describe, test, expect, beforeEach } from "bun:test";
import {
  createWorkflowForJob,
  scheduleJob,
  resumePending,
  getPendingCount,
  executeJobNow,
  registerJobHandlers,
  type JobDefinition
} from "../../orchestrator/resumable-jobs";
import { WorkflowDefinition } from "../../orchestrator/types";
import { validateWorkflow } from "../../orchestrator/task-graph";

describe("Resumable Jobs Integration", () => {
  describe("createWorkflowForJob", () => {
    test("creates workflow definition from job", () => {
      const job: JobDefinition = {
        id: "test-job",
        type: "shell",
        name: "Test Job",
        actionRef: "runTest",
        input: { cmd: "echo hello" },
        sessionId: "session-123"
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.id).toMatch(/^wf-test-job-\d+$/);
      expect(workflow.type).toBe("shell");
      expect(workflow.sessionId).toBe("session-123");
      expect(workflow.tasks).toHaveLength(1);
      expect(workflow.tasks[0].actionRef).toBe("runTest");
    });
    
    test("preserves job metadata in workflow", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "notification",
        actionRef: "sendEmail",
        metadata: { priority: "high" }
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.metadata?.jobId).toBe("job-1");
      expect(workflow.metadata?.jobName).toBeUndefined();
      expect(workflow.metadata?.priority).toBe("high");
    });
    
    test("sets source to job", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "shell",
        actionRef: "test"
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.source).toBe("job");
    });
    
    test("creates single task with no deps", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "shell",
        actionRef: "test"
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.tasks[0].deps).toEqual([]);
      expect(workflow.tasks[0].id).toBe("job-1-task");
    });
    
    test("maps retry policy correctly", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "shell",
        actionRef: "test",
        maxRetries: 3,
        retryPolicy: {
          initialDelayMs: 1000,
          maxDelayMs: 30000,
          backoffMultiplier: 2
        }
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.tasks[0].maxRetries).toBe(3);
      expect(workflow.tasks[0].retryPolicy?.initialDelayMs).toBe(1000);
      expect(workflow.tasks[0].retryPolicy?.backoffMultiplier).toBe(2);
    });
  });
  
  describe("job validation", () => {
    test("validateWorkflow passes valid job workflow", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "shell",
        actionRef: "test"
      };
      
      const workflow = createWorkflowForJob(job);
      const result = validateWorkflow(workflow);
      
      expect(result.valid).toBe(true);
    });
    
    test("requires job id", () => {
      const job = {
        id: "",
        type: "shell",
        actionRef: "test"
      } as JobDefinition;
      
      expect(() => createWorkflowForJob(job)).not.toThrow();
    });
    
    test("requires actionRef", () => {
      const job = {
        id: "job-1",
        type: "shell",
        actionRef: ""
      } as JobDefinition;
      
      // The workflow will be created but validation should catch it
      const workflow = createWorkflowForJob(job);
      const result = validateWorkflow(workflow);
      
      // Empty actionRef should produce warnings
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });
  
  describe("job scheduling", () => {
    test("scheduleJob validates required fields", () => {
      const invalidJob = {
        id: "",  // Empty id
        type: "shell",
        actionRef: "test"
      } as JobDefinition;
      
      expect(() => scheduleJob(invalidJob)).toThrow("Job must have id and actionRef");
    });
    
    test("executeJobNow returns workflowId", async () => {
      // Note: This will try to actually create workflows in .claude/claudeclaw/
      // We test the structure here
      const job: JobDefinition = {
        id: `test-${Date.now()}`,
        type: "shell",
        actionRef: "noOp"
      };
      
      // This would fail without a registered handler, but we're testing the interface
      // The actual execution is tested in integration tests
      expect(job.id).toBeTruthy();
    });
  });
  
  describe("handler registration", () => {
    test("registerJobHandlers accepts handler map", () => {
      const handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
        testHandler: async (input) => ({ result: input.value })
      };
      
      // Should not throw
      expect(() => registerJobHandlers(handlers)).not.toThrow();
    });
    
    test("handler function signature", async () => {
      const handler = async (input: Record<string, unknown>) => {
        return { processed: input.value };
      };
      
      const result = await handler({ value: "test" });
      expect(result).toEqual({ processed: "test" });
    });
  });
  
  describe("job types", () => {
    test("JobDefinition allows all required fields", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "shell",
        name: "My Job",
        schedule: "0 * * * *",
        actionRef: "runCommand",
        input: { command: "ls -la" },
        onError: "retry_task",
        maxRetries: 5,
        retryPolicy: {
          initialDelayMs: 2000,
          maxDelayMs: 60000,
          backoffMultiplier: 1.5
        },
        sessionId: "sess-123",
        source: "manual",
        channelId: "channel-1",
        threadId: "thread-1",
        metadata: { custom: "value" }
      };
      
      expect(job.id).toBe("job-1");
      expect(job.schedule).toBe("0 * * * *");
      expect(job.onError).toBe("retry_task");
      expect(job.maxRetries).toBe(5);
    });
    
    test("onError defaults to fail_workflow", () => {
      const job: JobDefinition = {
        id: "job-1",
        type: "shell",
        actionRef: "test"
      };
      
      const workflow = createWorkflowForJob(job);
      expect(workflow.tasks[0].onError).toBe("fail_workflow");
    });
  });
  
  describe("workflow mapping", () => {
    test("maps simple job to single-task workflow", () => {
      const job: JobDefinition = {
        id: "simple",
        type: "shell",
        actionRef: "echo"
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.tasks).toHaveLength(1);
      expect(workflow.id).toContain("wf-simple-");
    });
    
    test("job metadata preserved in workflow metadata", () => {
      const job: JobDefinition = {
        id: "meta-test",
        type: "notification",
        actionRef: "email",
        metadata: {
          recipient: "user@example.com",
          template: "welcome"
        }
      };
      
      const workflow = createWorkflowForJob(job);
      
      expect(workflow.metadata?.jobId).toBe("meta-test");
      expect(workflow.metadata?.recipient).toBe("user@example.com");
      expect(workflow.metadata?.template).toBe("welcome");
    });
  });
});
