import { describe, test, expect, beforeEach } from "bun:test";
import {
  selectModel,
  getFallbackChain,
  isModelAllowed,
  configureRouter,
  getRouterConfig,
} from "../../governance/model-router";
import {
  initBudgetEngine,
  upsertBudgetPolicy,
  resetBudgetEngine,
} from "../../governance/budget-engine";
import {
  initUsageTracker,
  recordInvocationStart,
  recordInvocationCompletion,
  resetUsageTracker,
} from "../../governance/usage-tracker";
import { join } from "path";

const BUDGET_POLICIES_FILE = join(process.cwd(), ".claude", "claudeclaw", "budget-policies.json");

describe("ModelRouter", () => {
  beforeEach(async () => {
    resetUsageTracker();
    resetBudgetEngine();
    
    // Clear budget policies file for test isolation
    try {
      const { rm } = await import("fs/promises");
      await rm(BUDGET_POLICIES_FILE, { force: true });
    } catch {
      // File might not exist
    }
    
    await initUsageTracker();
    await initBudgetEngine();
    
    // Reset router config
    configureRouter({
      defaultProvider: "anthropic",
      defaultModel: "claude-3-5-sonnet",
      fallbackChain: [
        { provider: "anthropic", model: "claude-3-5-sonnet" },
        { provider: "anthropic", model: "claude-3-haiku" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
    });
  });

  test("should select default model with healthy budget", async () => {
    const decision = await selectModel({});

    expect(decision.selectedProvider).toBe("anthropic");
    expect(decision.selectedModel).toBe("claude-3-5-sonnet");
    expect(decision.budgetState).toBe("healthy");
    expect(decision.reason).toContain("Default model selection");
  });

  test("should respect preferred provider/model", async () => {
    const decision = await selectModel({
      preferredProvider: "openai",
      preferredModel: "gpt-4o",
    });

    expect(decision.selectedProvider).toBe("openai");
    expect(decision.selectedModel).toBe("gpt-4o");
  });

  test("should return auditable decision", async () => {
    const decision = await selectModel({});

    expect(decision.requestId).toBeDefined();
    expect(decision.decidedAt).toBeDefined();
    expect(decision.reason).toBeDefined();
    expect(decision.fallbackChain).toBeDefined();
    expect(Array.isArray(decision.fallbackChain)).toBe(true);
  });

  test("should block execution when budget exceeded", async () => {
    // Create a policy that will be exceeded
    await upsertBudgetPolicy({
      name: "Very Low Limit",
      scope: { channelId: "low-limit-chan" },
      thresholds: { blockAt: 0.001 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    // Add usage that exceeds the limit
    const start = await recordInvocationStart({
      channelId: "low-limit-chan",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 100000, outputTokens: 50000 },
      { currency: "USD", totalCost: 0.50 }
    );

    const decision = await selectModel({ channelId: "low-limit-chan" });

    expect(decision.selectedModel).toBe("");
    expect(decision.budgetState).toBe("block");
    expect(decision.reason).toContain("blocked");
  });

  test("should allow explicit override when permitted", async () => {
    const decision = await selectModel({
      explicitOverride: {
        provider: "openai",
        model: "gpt-4o",
        allowed: true,
      },
    });

    expect(decision.selectedProvider).toBe("openai");
    expect(decision.selectedModel).toBe("gpt-4o");
    expect(decision.reason).toContain("override");
  });

  test("should use capability mapping", async () => {
    const decision = await selectModel({
      capability: "coding",
    });

    expect(decision.selectedProvider).toBe("anthropic");
    expect(decision.selectedModel).toBe("claude-3-5-sonnet");
  });

  test("should use fast capability for quick tasks", async () => {
    const decision = await selectModel({
      capability: "fast",
    });

    expect(decision.selectedProvider).toBe("anthropic");
    expect(decision.selectedModel).toBe("claude-3-haiku");
  });

  test("should provide fallback chain", async () => {
    const chain = await getFallbackChain({});

    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]).toHaveProperty("provider");
    expect(chain[0]).toHaveProperty("model");
  });

  test("should check model allowed status", async () => {
    const result = await isModelAllowed("anthropic", "claude-3-5-sonnet", {});

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeDefined();
  });

  test("should deny model when budget exceeded", async () => {
    // Create a policy that will be exceeded
    await upsertBudgetPolicy({
      name: "Deny Test",
      scope: { channelId: "deny-chan" },
      thresholds: { blockAt: 0.001 },
      period: "daily",
      currency: "USD",
      enabled: true,
    });

    // Add usage
    const start = await recordInvocationStart({
      channelId: "deny-chan",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(
      start.invocationId,
      { inputTokens: 100000, outputTokens: 50000 },
      { currency: "USD", totalCost: 0.50 }
    );

    const result = await isModelAllowed(
      "anthropic",
      "claude-3-5-sonnet",
      { channelId: "deny-chan" }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  test("should configure router", () => {
    configureRouter({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      degradeToModel: "claude-3-haiku",
      rerouteToProvider: "google",
    });

    const config = getRouterConfig();
    expect(config.defaultProvider).toBe("openai");
    expect(config.defaultModel).toBe("gpt-4o");
    expect(config.degradeToModel).toBe("claude-3-haiku");
    expect(config.rerouteToProvider).toBe("google");
  });

  test("should include budget state in decision", async () => {
    // Create usage that will trigger warn state
    await upsertBudgetPolicy({
      name: "Warn Test",
      scope: { channelId: "warn-chan" },
      thresholds: { warnAt: 0.01, degradeAt: 0.05 },
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
      { inputTokens: 5000, outputTokens: 2500 },
      { currency: "USD", totalCost: 0.02 } // Above warnAt
    );

    const decision = await selectModel({ channelId: "warn-chan" });

    expect(decision.budgetState).toBeDefined();
    expect(["warn", "degrade", "block"]).toContain(decision.budgetState);
    expect(decision.matchedPolicyId).toBeDefined();
  });
});
