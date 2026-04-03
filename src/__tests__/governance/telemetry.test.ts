import { describe, test, expect, beforeEach } from "bun:test";
import {
  getTelemetry,
  getTelemetrySummary,
  getProviderBreakdown,
  getModelBreakdown,
  getChannelBreakdown,
  getBudgetHealth,
} from "../../governance/telemetry";
import {
  initUsageTracker,
  recordInvocationStart,
  recordInvocationCompletion,
  resetUsageTracker,
} from "../../governance/usage-tracker";
import {
  initBudgetEngine,
  upsertBudgetPolicy,
  resetBudgetEngine,
} from "../../governance/budget-engine";

describe("Telemetry", () => {
  beforeEach(async () => {
    resetUsageTracker();
    resetBudgetEngine();
    await initUsageTracker();
    await initBudgetEngine();
  });

  test("should return telemetry summary", async () => {
    const summary = await getTelemetrySummary();

    expect(summary).toHaveProperty("totalInvocations");
    expect(summary).toHaveProperty("estimatedTotalCost");
    expect(summary).toHaveProperty("activeBudgets");
    expect(summary).toHaveProperty("blockedBudgets");
    expect(typeof summary.totalInvocations).toBe("number");
    expect(typeof summary.estimatedTotalCost).toBe("number");
  });

  test("should return comprehensive telemetry", async () => {
    // Create some usage data
    const context = {
      sessionId: "telemetry-session",
      channelId: "telegram:telemetry",
      source: "telegram",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };

    const start = await recordInvocationStart(context);

    await recordInvocationCompletion(
      start.invocationId,
      {
        inputTokens: 5000,
        outputTokens: 10000,
      },
      {
        currency: "USD",
        totalCost: 0.165,
      }
    );

    const telemetry = await getTelemetry({});

    expect(telemetry.estimatedTotalCost).toBeGreaterThan(0);
    expect(telemetry.invocationStats.total).toBeGreaterThan(0);
    expect(telemetry.invocationStats.completed).toBeGreaterThan(0);
    expect(telemetry.providerStats["anthropic"]).toBeDefined();
    expect(telemetry.modelStats["claude-3-5-sonnet"]).toBeDefined();
  });

  test("should filter telemetry by date range", async () => {
    const start = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 1000, outputTokens: 500 },
      { currency: "USD", totalCost: 0.02 }
    );

    // Future date should return empty
    const futureFilter = await getTelemetry({
      startDate: "2099-01-01T00:00:00Z",
    });
    expect(futureFilter.invocationStats.total).toBe(0);

    // Past date should include data
    const pastFilter = await getTelemetry({
      startDate: "1970-01-01T00:00:00Z",
    });
    expect(pastFilter.invocationStats.total).toBeGreaterThan(0);
  });

  test("should filter telemetry by provider", async () => {
    // Anthropic invocation
    const anthropicStart = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    await recordInvocationCompletion(
      anthropicStart.invocationId,
      { inputTokens: 1000, outputTokens: 500 },
      { currency: "USD", totalCost: 0.02 }
    );

    // OpenAI invocation
    const openaiStart = await recordInvocationStart({
      provider: "openai",
      model: "gpt-4o",
    });
    await recordInvocationCompletion(
      openaiStart.invocationId,
      { inputTokens: 1000, outputTokens: 500 },
      { currency: "USD", totalCost: 0.03 }
    );

    const anthropicTelemetry = await getTelemetry({ provider: "anthropic" });
    expect(anthropicTelemetry.providerStats["anthropic"]).toBeDefined();
    expect(anthropicTelemetry.providerStats["openai"]).toBeUndefined();
  });

  test("should return provider breakdown", async () => {
    const start = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 10000, outputTokens: 5000 },
      { currency: "USD", totalCost: 0.105 }
    );

    const breakdown = await getProviderBreakdown();

    expect(Array.isArray(breakdown)).toBe(true);
    const anthropic = breakdown.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.calls).toBeGreaterThan(0);
    expect(anthropic!.tokens).toBeGreaterThan(0);
  });

  test("should return model breakdown", async () => {
    const start = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-haiku",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 500, outputTokens: 250 },
      { currency: "USD", totalCost: 0.005 }
    );

    const breakdown = await getModelBreakdown();

    expect(Array.isArray(breakdown)).toBe(true);
    const haiku = breakdown.find((m) => m.model === "claude-3-haiku");
    expect(haiku).toBeDefined();
    expect(haiku!.calls).toBeGreaterThan(0);
  });

  test("should return channel breakdown", async () => {
    const start = await recordInvocationStart({
      channelId: "discord:12345",
      source: "discord",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 2000, outputTokens: 1000 },
      { currency: "USD", totalCost: 0.045 }
    );

    const breakdown = await getChannelBreakdown();

    expect(Array.isArray(breakdown)).toBe(true);
    const discord = breakdown.find((c) => c.channelId === "discord:12345");
    expect(discord).toBeDefined();
    expect(discord!.invocations).toBeGreaterThan(0);
  });

  test("should return budget health", async () => {
    // Create a policy
    await upsertBudgetPolicy({
      name: "Health Test Policy",
      scope: { channelId: "health-chan" },
      thresholds: { warnAt: 10, degradeAt: 20, blockAt: 50 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    const health = await getBudgetHealth();

    expect(Array.isArray(health)).toBe(true);
    const policy = health.find((h) => h.policyName === "Health Test Policy");
    expect(policy).toBeDefined();
    expect(policy!.state).toBeDefined();
  });

  test("should handle empty telemetry gracefully", async () => {
    const telemetry = await getTelemetry({
      startDate: "2099-01-01T00:00:00Z",
    });

    expect(telemetry.totalSessions).toBe(0);
    expect(telemetry.invocationStats.total).toBe(0);
    expect(telemetry.estimatedTotalCost).toBe(0);
  });

  test("should include cost breakdown in aggregates", async () => {
    const start = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      {
        inputTokens: 1000000, // 1M
        outputTokens: 500000, // 500K
      },
      {
        currency: "USD",
        inputCost: 3.0,
        outputCost: 7.5,
        cacheCost: 0.5,
        totalCost: 11.0,
      }
    );

    const telemetry = await getTelemetry({});

    expect(telemetry.estimatedTotalCost).toBeGreaterThan(0);
    const anthropicStats = telemetry.providerStats["anthropic"];
    expect(anthropicStats).toBeDefined();
    expect(anthropicStats!.estimatedCost).toBeGreaterThan(0);
  });
});
