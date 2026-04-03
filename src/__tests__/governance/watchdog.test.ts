import { describe, test, expect, beforeEach } from "bun:test";
import {
  initWatchdog,
  recordExecutionMetric,
  incrementToolCall,
  incrementTurnCount,
  checkLimits,
  handleTrigger,
  getActiveInvocation,
  getSessionActiveInvocations,
  clearInvocation,
  getWatchdogStats,
  configureWatchdog,
  getWatchdogConfig,
  resetWatchdog,
} from "../../governance/watchdog";
import { join } from "path";

const WATCHDOG_DIR = join(process.cwd(), ".claude", "claudeclaw", "watchdog");

describe("Watchdog", () => {
  beforeEach(async () => {
    resetWatchdog();
    
    // Clear watchdog directory for test isolation
    try {
      const { rm, readdir } = await import("fs/promises");
      const files = await readdir(WATCHDOG_DIR);
      for (const file of files) {
        if (file !== ".gitkeep") {
          await rm(join(WATCHDOG_DIR, file), { recursive: true, force: true });
        }
      }
    } catch {
      // Directory might not exist yet
    }
    
    await initWatchdog();
    
    // Configure with relaxed limits for testing
    configureWatchdog({
      limits: {
        maxToolCalls: 10,
        maxTurns: 5,
        maxRuntimeSeconds: 60,
        maxRepeatedTools: 3,
        repeatedToolThreshold: 2,
      },
      enabled: true,
    });
  });

  test("should initialize with config", async () => {
    const config = getWatchdogConfig();
    expect(config.enabled).toBe(true);
    expect(config.limits.maxToolCalls).toBe(10);
  });

  test("should configure watchdog limits", () => {
    configureWatchdog({
      limits: {
        maxToolCalls: 50,
        maxTurns: 20,
      },
    });

    const config = getWatchdogConfig();
    expect(config.limits.maxToolCalls).toBe(50);
    expect(config.limits.maxTurns).toBe(20);
  });

  test("should record execution metrics", async () => {
    const invocationId = "test-invocation-1";

    await recordExecutionMetric({
      invocationId,
      sessionId: "test-session",
    }, {
      toolCallCount: 5,
      turnCount: 2,
    });

    const metrics = await getActiveInvocation(invocationId);
    expect(metrics).not.toBeNull();
    expect(metrics!.toolCallCount).toBe(5);
    expect(metrics!.turnCount).toBe(2);
    expect(metrics!.invocationId).toBe(invocationId);
  });

  test("should increment tool call count", async () => {
    const invocationId = "test-invocation-2";

    await incrementToolCall(invocationId, "read_file", { path: "/tmp/test.txt" });
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/test.txt" });
    await incrementToolCall(invocationId, "write_file", { path: "/tmp/output.txt" });

    const metrics = await getActiveInvocation(invocationId);
    expect(metrics!.toolCallCount).toBe(3);
    expect(metrics!.toolCalls.length).toBe(3);
  });

  test("should increment turn count", async () => {
    const invocationId = "test-invocation-3";

    await incrementTurnCount(invocationId);
    await incrementTurnCount(invocationId);

    const metrics = await getActiveInvocation(invocationId);
    expect(metrics!.turnCount).toBe(2);
  });

  test("should return healthy when under limits", async () => {
    const invocationId = "test-invocation-healthy";

    await recordExecutionMetric({
      invocationId,
    }, {
      toolCallCount: 3,
      turnCount: 2,
    });

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("healthy");
    expect(decision.triggeredLimits.length).toBe(0);
  });

  test("should warn at 80% of tool call limit", async () => {
    const invocationId = "test-invocation-warn";

    // 8 out of 10 = 80%
    await recordExecutionMetric({
      invocationId,
    }, {
      toolCallCount: 8,
      turnCount: 1,
    });

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("warn");
    expect(decision.triggeredLimits.length).toBeGreaterThan(0);
  });

  test("should trigger suspend at tool call limit", async () => {
    const invocationId = "test-invocation-suspend";

    await recordExecutionMetric({
      invocationId,
    }, {
      toolCallCount: 10, // At limit
      turnCount: 1,
    });

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("suspend");
    expect(decision.triggeredLimits.some(l => l.includes("maxToolCalls"))).toBe(true);
  });

  test("should detect repeated tool patterns", async () => {
    const invocationId = "test-invocation-repeat";

    // Make same tool call 3 times with same input
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/same.txt" });
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/same.txt" });
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/same.txt" });

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("suspend");
    expect(decision.triggeredLimits.some(l => l.includes("Repeated"))).toBe(true);
  });

  test("should handle trigger for warn state", async () => {
    const invocationId = "test-invocation-warn-handle";

    await recordExecutionMetric({
      invocationId,
    }, {
      toolCallCount: 8, // Warning level
    });

    const decision = await checkLimits({ invocationId });
    const result = await handleTrigger({ invocationId }, decision);

    expect(result.success).toBe(true);
    expect(["warning_logged", "no_action"]).toContain(result.action);
  });

  test("should handle trigger for suspend state", async () => {
    const invocationId = "test-invocation-suspend-handle";

    await recordExecutionMetric({
      invocationId,
    }, {
      toolCallCount: 10, // At limit
    });

    const decision = await checkLimits({ invocationId });
    const result = await handleTrigger({ invocationId }, decision);

    expect(result.success).toBe(true);
    expect(["suspended", "paused"]).toContain(result.action);
  });

  test("should handle trigger for kill state", async () => {
    const invocationId = "test-invocation-kill";

    await recordExecutionMetric({
      invocationId,
    }, {
      toolCallCount: 100, // Way over
    });

    const decision = await checkLimits({ invocationId });
    decision.state = "kill"; // Force kill state for testing

    const result = await handleTrigger({ invocationId }, decision);

    expect(result.success).toBe(true);
    expect(result.action).toBe("terminated");

    // Should be cleared from active invocations
    const metrics = await getActiveInvocation(invocationId);
    expect(metrics).toBeNull();
  });

  test("should get session active invocations", async () => {
    const sessionId = "test-session-watchdog";

    await recordExecutionMetric({ invocationId: "inv-1", sessionId }, { toolCallCount: 1 });
    await recordExecutionMetric({ invocationId: "inv-2", sessionId }, { toolCallCount: 2 });
    await recordExecutionMetric({ invocationId: "inv-3", sessionId: "other" }, { toolCallCount: 3 });

    const invocations = await getSessionActiveInvocations(sessionId);

    expect(invocations.length).toBe(2);
    expect(invocations.find(i => i.invocationId === "inv-1")).toBeDefined();
    expect(invocations.find(i => i.invocationId === "inv-2")).toBeDefined();
  });

  test("should clear invocation", async () => {
    const invocationId = "inv-to-clear";

    await recordExecutionMetric({ invocationId }, { toolCallCount: 5 });

    let metrics = await getActiveInvocation(invocationId);
    expect(metrics).not.toBeNull();

    await clearInvocation(invocationId);

    metrics = await getActiveInvocation(invocationId);
    expect(metrics).toBeNull();
  });

  test("should get watchdog stats", async () => {
    await recordExecutionMetric({ invocationId: "stats-inv-1" }, { toolCallCount: 5 });
    await recordExecutionMetric({ invocationId: "stats-inv-2" }, { toolCallCount: 3 });

    // Trigger a watchdog decision to log an event
    await checkLimits({ invocationId: "stats-inv-1" });

    const stats = await getWatchdogStats();

    expect(stats.activeInvocations).toBe(2);
    expect(stats.config.enabled).toBe(true);
    expect(stats.eventsLogged).toBeGreaterThan(0);
  });

  test("should return healthy for unknown invocation", async () => {
    const decision = await checkLimits({ invocationId: "unknown-invocation" });

    expect(decision.state).toBe("healthy");
    expect(decision.reason).toContain("No execution metrics");
  });
});
