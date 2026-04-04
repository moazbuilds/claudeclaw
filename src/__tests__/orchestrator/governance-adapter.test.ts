import { describe, test, expect, beforeEach, vi } from "bun:test";
import type { GovernanceCheck } from "../../orchestrator/executor";

// Mock the real GovernanceClient
const mockEvaluateToolRequest = vi.fn();
const mockGetGovernanceClient = vi.fn(() => ({
  evaluateToolRequest: mockEvaluateToolRequest,
}));

// Mock evaluateBudget
const mockEvaluateBudget = vi.fn();

vi.mock("../../governance/client", () => ({
  GovernanceClient: class MockRealGovernanceClient {
    evaluateToolRequest = mockEvaluateToolRequest;
  },
  getGovernanceClient: mockGetGovernanceClient,
}));

vi.mock("../../governance", () => ({
  evaluateBudget: mockEvaluateBudget,
  getBudgetState: vi.fn(),
}));

// Import after mocks
import { OrchestratorGovernanceAdapter } from "../../orchestrator/governance-adapter";

describe("OrchestratorGovernanceAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkPolicy", () => {
    test("returns GovernanceCheck with allowed=true when policy allows", async () => {
      mockEvaluateToolRequest.mockReturnValue({
        requestId: "req-123",
        action: "allow",
        reason: "Allowed by policy",
        evaluatedAt: new Date().toISOString(),
        cacheable: true,
      });

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkPolicy("channel-1", "sendNotification");

      expect(result).toEqual({
        allowed: true,
        reason: "Allowed by policy",
        blockedBy: undefined,
      });
      expect(mockEvaluateToolRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "channel-1",
          toolName: "sendNotification",
          source: "orchestrator",
        })
      );
    });

    test("returns GovernanceCheck with allowed=false and reason when policy denies", async () => {
      mockEvaluateToolRequest.mockReturnValue({
        requestId: "req-456",
        action: "deny",
        reason: "Tool not permitted",
        evaluatedAt: new Date().toISOString(),
        cacheable: false,
      });

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkPolicy("channel-2", "deleteResource");

      expect(result).toEqual({
        allowed: false,
        reason: "Tool not permitted",
        blockedBy: "policy",
      });
    });

    test("returns GovernanceCheck with allowed=false when require_approval", async () => {
      mockEvaluateToolRequest.mockReturnValue({
        requestId: "req-789",
        action: "require_approval",
        reason: "Approval required for this tool",
        evaluatedAt: new Date().toISOString(),
        cacheable: false,
      });

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkPolicy("channel-3", "deploy");

      expect(result).toEqual({
        allowed: false,
        reason: "Approval required for this tool",
        blockedBy: "policy",
      });
    });

    test("wraps sync evaluateToolRequest in Promise", async () => {
      mockEvaluateToolRequest.mockReturnValue({
        requestId: "req-sync",
        action: "allow",
        reason: "OK",
        evaluatedAt: new Date().toISOString(),
        cacheable: true,
      });

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkPolicy("channel-sync", "testAction");

      expect(result.allowed).toBe(true);
      expect(mockEvaluateToolRequest).toHaveBeenCalled();
    });

    test("generates proper ToolRequestContext with UUID eventId", async () => {
      mockEvaluateToolRequest.mockReturnValue({
        requestId: "req-uuid",
        action: "allow",
        reason: "OK",
        evaluatedAt: new Date().toISOString(),
        cacheable: true,
      });

      const adapter = new OrchestratorGovernanceAdapter();
      await adapter.checkPolicy("channel-test", "testAction");

      const callArg = mockEvaluateToolRequest.mock.calls[0][0];
      expect(callArg.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(callArg.source).toBe("orchestrator");
      expect(callArg.channelId).toBe("channel-test");
      expect(callArg.toolName).toBe("testAction");
      expect(callArg.toolArgs).toBeUndefined();
      expect(callArg.timestamp).toBeDefined();
    });
  });

  describe("checkBudget", () => {
    test("returns GovernanceCheck with allowed=true when budget OK", async () => {
      mockEvaluateBudget.mockResolvedValue([
        {
          policyId: "budget-1",
          policyName: "Session Budget",
          state: "healthy",
          currentSpend: 0.5,
          threshold: 10,
          percentage: 5,
          period: "session" as const,
          currency: "USD",
          actions: { shouldWarn: false, shouldDegrade: false, shouldReroute: false, shouldBlock: false },
          evaluatedAt: new Date().toISOString(),
        },
      ]);

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkBudget("session-123", "sendNotification");

      expect(result).toEqual({
        allowed: true,
        reason: undefined,
        blockedBy: undefined,
      });
      expect(mockEvaluateBudget).toHaveBeenCalledWith({ sessionId: "session-123" });
    });

    test("returns GovernanceCheck with allowed=false when budget exceeded (block state)", async () => {
      mockEvaluateBudget.mockResolvedValue([
        {
          policyId: "budget-block",
          policyName: "Channel Budget",
          state: "block",
          currentSpend: 15,
          threshold: 10,
          percentage: 150,
          period: "daily" as const,
          currency: "USD",
          actions: { shouldWarn: true, shouldDegrade: true, shouldReroute: true, shouldBlock: true },
          evaluatedAt: new Date().toISOString(),
        },
      ]);

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkBudget("session-456", "expensiveAction");

      expect(result).toEqual({
        allowed: false,
        reason: "Budget exceeded: Channel Budget",
        blockedBy: "budget",
      });
    });

    test("returns GovernanceCheck with allowed=false when any evaluation has block state", async () => {
      mockEvaluateBudget.mockResolvedValue([
        {
          policyId: "budget-warn",
          policyName: "Warning Budget",
          state: "warn",
          currentSpend: 8,
          threshold: 10,
          percentage: 80,
          period: "session" as const,
          currency: "USD",
          actions: { shouldWarn: true, shouldDegrade: false, shouldReroute: false, shouldBlock: false },
          evaluatedAt: new Date().toISOString(),
        },
        {
          policyId: "budget-block",
          policyName: "Hard Limit",
          state: "block",
          currentSpend: 100,
          threshold: 50,
          percentage: 200,
          period: "monthly" as const,
          currency: "USD",
          actions: { shouldWarn: true, shouldDegrade: true, shouldReroute: true, shouldBlock: true },
          evaluatedAt: new Date().toISOString(),
        },
      ]);

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkBudget("session-789", "anyAction");

      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("budget");
      expect(result.reason).toBe("Budget exceeded: Hard Limit");
    });

    test("awaits async evaluateBudget properly", async () => {
      mockEvaluateBudget.mockResolvedValue([]);

      const adapter = new OrchestratorGovernanceAdapter();
      const result = await adapter.checkBudget("session-async", "action");

      expect(result.allowed).toBe(true);
      expect(mockEvaluateBudget).toHaveBeenCalled();
    });
  });

  describe("constructor", () => {
    test("uses default governance client when none provided", () => {
      mockGetGovernanceClient.mockReturnValue({
        evaluateToolRequest: mockEvaluateToolRequest,
      });

      const adapter = new OrchestratorGovernanceAdapter();

      expect(mockGetGovernanceClient).toHaveBeenCalled();
    });

    test("uses provided governance client instance", () => {
      const customClient = {
        evaluateToolRequest: vi.fn().mockReturnValue({
          requestId: "custom",
          action: "allow",
          reason: "Custom client",
          evaluatedAt: new Date().toISOString(),
          cacheable: true,
        }),
      };

      const adapter = new OrchestratorGovernanceAdapter(customClient as any);
      adapter.checkPolicy("ch", "action");

      expect(customClient.evaluateToolRequest).toHaveBeenCalled();
    });
  });
});
