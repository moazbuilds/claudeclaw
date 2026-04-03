import { describe, it, expect, beforeEach } from "bun:test";
import { evaluate } from "../../../src/policy/engine";
import { enqueue, loadState, listPending, findByEventId } from "../../../src/policy/approval-queue";
import { initGovernanceClient, getGovernanceClient, type GovernanceClient } from "../../../src/governance/client";

describe("Policy Wiring Integration", () => {
  beforeEach(async () => {
    // Reset and reinitialize
    await loadState();
    initGovernanceClient({ policyEnabled: true, approvalEnabled: true });
  });

  describe("GovernanceClient", () => {
    it("should evaluate tool requests through policy engine", () => {
      const gc = getGovernanceClient();
      const request = {
        eventId: "test-event-1",
        source: "telegram",
        channelId: "telegram:123",
        userId: "user1",
        toolName: "Read",
        timestamp: new Date().toISOString(),
      };

      const decision = gc.evaluateToolRequest(request);
      expect(decision).toBeDefined();
      expect(decision.action).toMatch(/^(allow|deny|require_approval)$/);
    });

    it("should detect allow decisions", () => {
      const gc = getGovernanceClient();
      const request = {
        eventId: "test-event-2",
        source: "telegram",
        channelId: "telegram:123",
        toolName: "Read",
        timestamp: new Date().toISOString(),
      };

      const allowed = gc.isToolAllowed(request);
      expect(typeof allowed).toBe("boolean");
    });

    it("should detect require_approval decisions", () => {
      const gc = getGovernanceClient();
      const request = {
        eventId: "test-event-3",
        source: "discord",
        channelId: "discord:456",
        toolName: "Edit",
        timestamp: new Date().toISOString(),
      };

      const requiresApproval = gc.requiresApproval(request);
      expect(typeof requiresApproval).toBe("boolean");
    });
  });

  describe("Policy Engine evaluate()", () => {
    it("should return deny when no rules match (default deny)", () => {
      const request = {
        eventId: "test-event-deny",
        source: "unknown",
        toolName: "SomeTool",
        timestamp: new Date().toISOString(),
      };

      const decision = evaluate(request);
      expect(decision.action).toBe("deny");
      expect(decision.reason).toContain("No matching policy rule");
    });

    it("should include requestId and evaluatedAt in decision", () => {
      const request = {
        eventId: "test-event-meta",
        source: "telegram",
        toolName: "View",
        timestamp: new Date().toISOString(),
      };

      const decision = evaluate(request);
      expect(decision.requestId).toBeDefined();
      expect(decision.evaluatedAt).toBeDefined();
    });
  });

  describe("Approval Queue enqueue()", () => {
    it("should enqueue require_approval requests", async () => {
      const request = {
        eventId: "test-approval-event",
        source: "telegram",
        toolName: "Edit",
        timestamp: new Date().toISOString(),
      };

      const decision = {
        requestId: "test-req-id",
        action: "require_approval" as const,
        reason: "Edit requires approval",
        evaluatedAt: new Date().toISOString(),
      };

      const entry = await enqueue(request, decision);
      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
      expect(entry.status).toBe("pending");
      expect(entry.eventId).toBe("test-approval-event");
    });

    it("should find enqueued approval by eventId", async () => {
      const eventId = "test-find-event-" + Date.now();
      const request = {
        eventId,
        source: "discord",
        toolName: "Bash",
        timestamp: new Date().toISOString(),
      };

      const decision = {
        requestId: "test-req-id-2",
        action: "require_approval" as const,
        reason: "Bash requires approval",
        evaluatedAt: new Date().toISOString(),
      };

      await enqueue(request, decision);
      const found = await findByEventId(eventId);
      expect(found).toBeDefined();
      expect(found?.eventId).toBe(eventId);
    });

    it("should list pending approvals", async () => {
      const pending = listPending();
      expect(Array.isArray(pending)).toBe(true);
    });
  });
});
