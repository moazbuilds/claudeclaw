import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initBudgetEngine,
  evaluateBudget,
  getBudgetState,
  upsertBudgetPolicy,
  deleteBudgetPolicy,
  loadPricingConfig,
  loadPolicies,
  calculateEstimatedCost,
  createDefaultPoliciesForChannel,
  resetBudgetEngine,
  type BudgetPolicy,
} from "../../governance/budget-engine";
import { join } from "path";
import {
  initUsageTracker,
  recordInvocationStart,
  recordInvocationCompletion,
  resetUsageTracker,
} from "../../governance/usage-tracker";

const BUDGET_POLICIES_FILE = join(process.cwd(), ".claude", "claudeclaw", "budget-policies.json");
const USAGE_DIR = join(process.cwd(), ".claude", "claudeclaw", "usage");

describe("BudgetEngine", () => {
  beforeEach(async () => {
    const { rm, readdir } = await import("fs/promises");
    
    // Clean budget policies file for test isolation
    try {
      await rm(BUDGET_POLICIES_FILE, { force: true });
    } catch {
      // File might not exist
    }
    
    // Clean usage directory for test isolation
    try {
      const files = await readdir(USAGE_DIR);
      await Promise.all(
        files
          .filter(f => f !== ".gitkeep")
          .map(f => rm(join(USAGE_DIR, f), { force: true }))
      );
    } catch {
      // Directory might not exist
    }
    
    resetBudgetEngine();
    resetUsageTracker();
    await initUsageTracker();
    await initBudgetEngine();
  });

  afterEach(async () => {
    resetBudgetEngine();
    resetUsageTracker();
  });

  test("should initialize with default pricing", async () => {
    const pricing = await loadPricingConfig();
    expect(pricing.version).toBe("1.0.0");
    expect(pricing.tiers.length).toBeGreaterThan(0);
    expect(pricing.tiers[0].provider).toBe("anthropic");
  });

  test("should create budget policy", async () => {
    const policy = await upsertBudgetPolicy({
      name: "Test Policy",
      scope: { channelId: "test-channel" },
      thresholds: {
        warnAt: 10,
        degradeAt: 20,
        blockAt: 50,
      },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    expect(policy.id).toBeDefined();
    expect(policy.name).toBe("Test Policy");
    expect(policy.thresholds.warnAt).toBe(10);
    expect(policy.thresholds.degradeAt).toBe(20);
    expect(policy.thresholds.blockAt).toBe(50);
  });

  test("should update existing policy", async () => {
    const created = await upsertBudgetPolicy({
      name: "Original Name",
      scope: {},
      thresholds: {},
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const updated = await upsertBudgetPolicy({
      id: created.id,
      name: "Updated Name",
      scope: {},
      thresholds: { warnAt: 5 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe("Updated Name");
    expect(updated.thresholds.warnAt).toBe(5);
  });

  test("should delete budget policy", async () => {
    const policy = await upsertBudgetPolicy({
      name: "To Delete",
      scope: {},
      thresholds: {},
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const deleted = await deleteBudgetPolicy(policy.id);
    expect(deleted).toBe(true);

    const policies = await loadPolicies();
    expect(policies.find((p) => p.id === policy.id)).toBeUndefined();
  });

  test("should evaluate healthy budget when under threshold", async () => {
    await upsertBudgetPolicy({
      name: "Low Limit Policy",
      scope: { channelId: "test-chan" },
      thresholds: { warnAt: 100, degradeAt: 200, blockAt: 500 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    // Create a small invocation
    const start = await recordInvocationStart({
      channelId: "test-chan",
      provider: "anthropic",
      model: "claude-3-haiku",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 100, outputTokens: 100 },
      { currency: "USD", totalCost: 0.001 }
    );

    const evaluation = await evaluateBudget({ channelId: "test-chan" });
    expect(evaluation.length).toBeGreaterThan(0);
    expect(evaluation[0].state).toBe("healthy");
  });

  test("should evaluate warn state at threshold", async () => {
    const policy = await upsertBudgetPolicy({
      name: "Warn Test",
      scope: { channelId: "warn-chan" },
      thresholds: { warnAt: 0.05, degradeAt: 0.10 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const start = await recordInvocationStart({
      channelId: "warn-chan",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 10000, outputTokens: 5000 },
      { currency: "USD", totalCost: 0.06 } // Above warnAt
    );

    const evaluation = await evaluateBudget({ channelId: "warn-chan" });
    expect(evaluation[0].state).toBe("warn");
    expect(evaluation[0].actions.shouldWarn).toBe(true);
  });

  test("should return degrade state when threshold exceeded", async () => {
    await upsertBudgetPolicy({
      name: "Degrade Test",
      scope: { channelId: "degrade-chan" },
      thresholds: { warnAt: 0.01, degradeAt: 0.05, blockAt: 0.10 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const start = await recordInvocationStart({
      channelId: "degrade-chan",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 20000, outputTokens: 10000 },
      { currency: "USD", totalCost: 0.08 } // Above degradeAt
    );

    const evaluation = await evaluateBudget({ channelId: "degrade-chan" });
    expect(["degrade", "reroute", "block"]).toContain(evaluation[0].state);
  });

  test("should return block state at block threshold", async () => {
    await upsertBudgetPolicy({
      name: "Block Test",
      scope: { channelId: "block-chan" },
      thresholds: { warnAt: 0.01, degradeAt: 0.05, blockAt: 0.10 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const start = await recordInvocationStart({
      channelId: "block-chan",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 40000, outputTokens: 20000 },
      { currency: "USD", totalCost: 0.15 } // Above blockAt
    );

    const evaluation = await evaluateBudget({ channelId: "block-chan" });
    expect(evaluation[0].state).toBe("block");
    expect(evaluation[0].actions.shouldBlock).toBe(true);
  });

  test("should calculate estimated cost correctly", async () => {
    const cost = calculateEstimatedCost(
      {
        inputTokens: 1000000, // 1M input
        outputTokens: 500000, // 500K output
        cacheCreationInputTokens: 100000,
        cacheReadInputTokens: 200000,
      },
      "anthropic",
      "claude-3-5-sonnet"
    );

    expect(cost).not.toBeNull();
    // 1M * $3 + 500K * $15 + 100K * $3.75 + 200K * $0.30 / 1M
    // = $3 + $7.5 + $0.375 + $0.06 = $10.935
    expect(cost!.totalCost).toBeCloseTo(10.935, 2);
  });

  test("should create default policies for channel", async () => {
    const policies = await createDefaultPoliciesForChannel("new-channel", {
      dailyLimit: 10,
      monthlyLimit: 100,
    });

    expect(policies.length).toBe(2);
    expect(policies.find((p) => p.period === "daily")).toBeDefined();
    expect(policies.find((p) => p.period === "monthly")).toBeDefined();
  });

  test("should scope policies correctly", async () => {
    // Policy for specific channel
    await upsertBudgetPolicy({
      name: "Channel Specific",
      scope: { channelId: "specific-chan" },
      thresholds: { blockAt: 1 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    // Policy for all channels
    await upsertBudgetPolicy({
      name: "Global",
      scope: {},
      thresholds: { blockAt: 1000 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const evalForSpecific = await evaluateBudget({ channelId: "specific-chan" });
    const evalForOther = await evaluateBudget({ channelId: "other-chan" });

    // Should have both policies for specific channel
    expect(evalForSpecific.length).toBe(2);

    // Should only have global policy for other channel
    expect(evalForOther.length).toBe(1);
    expect(evalForOther[0].policyName).toBe("Global");
  });

  test("should respect period boundaries", async () => {
    const policy = await upsertBudgetPolicy({
      name: "Session Policy",
      scope: {},
      thresholds: { warnAt: 0.001 },
      period: "session",
      currency: "USD",
      enabled: true,
    });

    // Session-scoped policy should evaluate based on session usage
    const start = await recordInvocationStart({
      sessionId: "test-session",
      provider: "anthropic",
      model: "claude-3-haiku",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 1000, outputTokens: 500 },
      { currency: "USD", totalCost: 0.005 }
    );

    const eval_ = await evaluateBudget({ sessionId: "test-session" });
    // Should evaluate session policy
    expect(eval_.some((e) => e.policyId === policy.id)).toBe(true);
  });
});
