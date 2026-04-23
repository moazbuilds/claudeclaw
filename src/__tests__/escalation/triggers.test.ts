/**
 * Tests for escalation/triggers.ts
 * 
 * Run with: bun test src/__tests__/escalation/triggers.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  handleEscalationTrigger,
  shouldPause,
  shouldCreateHandoff,
  shouldNotify,
  configureEscalationPolicy,
  getEscalationPolicy,
  resetEscalationPolicy,
  handlePolicyDenial,
  handleWatchdogTrigger,
  handleDlqOverflow,
  handleOrchestrationFailure,
  handleManualEscalation,
  resetTriggerIntegration,
  getFailureCounts,
  clearFailureCount,
  type TriggerContext,
  type EscalationPolicy,
} from "../../escalation/triggers";
import { getPauseState, resetPauseController } from "../../escalation/pause";
import { listHandoffs, resetHandoffManager } from "../../escalation/handoff";
import { listNotifications, resetNotificationManager } from "../../escalation/notifications";
import type { WatchdogDecision } from "../../governance/watchdog";

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");

describe("Escalation Triggers - Policy Management", () => {
  beforeEach(() => {
    resetEscalationPolicy();
  });

  it("should have default policy", () => {
    const policy = getEscalationPolicy();
    
    expect(policy.pauseOnCriticalPolicyDenial).toBe(true);
    expect(policy.pauseOnWatchdogSuspend).toBe(true);
    expect(policy.createHandoffOnPolicyDenial).toBe(true);
    expect(policy.notifyOnPolicyDenial).toBe(true);
    expect(policy.minHandoffSeverity).toBe("warning");
    expect(policy.repeatedFailureThreshold).toBe(3);
  });

  it("should update policy", () => {
    configureEscalationPolicy({
      pauseOnCriticalPolicyDenial: false,
      minHandoffSeverity: "critical",
    });
    
    const policy = getEscalationPolicy();
    expect(policy.pauseOnCriticalPolicyDenial).toBe(false);
    expect(policy.minHandoffSeverity).toBe("critical");
    // Other values should remain
    expect(policy.pauseOnWatchdogSuspend).toBe(true);
  });

  it("should reset policy to defaults", () => {
    configureEscalationPolicy({ pauseOnCriticalPolicyDenial: false });
    resetEscalationPolicy();
    
    const policy = getEscalationPolicy();
    expect(policy.pauseOnCriticalPolicyDenial).toBe(true);
  });
});

describe("Escalation Triggers - shouldPause", () => {
  beforeEach(() => {
    resetEscalationPolicy();
  });

  it("should pause on critical policy denial", () => {
    const context: TriggerContext = {
      source: "policy_denial",
      severity: "critical",
    };
    
    expect(shouldPause(context)).toBe(true);
  });

  it("should not pause on non-critical policy denial", () => {
    const context: TriggerContext = {
      source: "policy_denial",
      severity: "warning",
    };
    
    expect(shouldPause(context)).toBe(false);
  });

  it("should pause on watchdog suspend", () => {
    const decision: WatchdogDecision = {
      invocationId: "test",
      state: "suspend",
      reason: "Too many tool calls",
      triggeredLimits: ["maxToolCalls"],
      recommendedAction: "pause",
      evaluatedAt: new Date().toISOString(),
    };
    
    const context: TriggerContext = {
      source: "watchdog",
      watchdogDecision: decision,
    };
    
    expect(shouldPause(context)).toBe(true);
  });

  it("should pause on watchdog kill", () => {
    const decision: WatchdogDecision = {
      invocationId: "test",
      state: "kill",
      reason: "Runaway execution",
      triggeredLimits: ["maxRuntimeSeconds"],
      recommendedAction: "terminate",
      evaluatedAt: new Date().toISOString(),
    };
    
    const context: TriggerContext = {
      source: "watchdog",
      watchdogDecision: decision,
    };
    
    expect(shouldPause(context)).toBe(true);
  });

  it("should not pause on watchdog warn", () => {
    const decision: WatchdogDecision = {
      invocationId: "test",
      state: "warn",
      reason: "Approaching limit",
      triggeredLimits: [],
      recommendedAction: "review",
      evaluatedAt: new Date().toISOString(),
    };
    
    const context: TriggerContext = {
      source: "watchdog",
      watchdogDecision: decision,
    };
    
    expect(shouldPause(context)).toBe(false);
  });

  it("should not pause on manual escalation", () => {
    const context: TriggerContext = {
      source: "manual_escalation",
      severity: "critical",
    };
    
    expect(shouldPause(context)).toBe(false);
  });

  it("should respect policy disable", () => {
    configureEscalationPolicy({ pauseOnCriticalPolicyDenial: false });
    
    const context: TriggerContext = {
      source: "policy_denial",
      severity: "critical",
    };
    
    expect(shouldPause(context)).toBe(false);
  });
});

describe("Escalation Triggers - shouldCreateHandoff", () => {
  beforeEach(() => {
    resetEscalationPolicy();
  });

  it("should create handoff on policy denial", () => {
    const context: TriggerContext = {
      source: "policy_denial",
      severity: "warning",
    };
    
    expect(shouldCreateHandoff(context)).toBe(true);
  });

  it("should not create handoff below minimum severity", () => {
    configureEscalationPolicy({ minHandoffSeverity: "critical" });
    
    const context: TriggerContext = {
      source: "policy_denial",
      severity: "warning",
    };
    
    expect(shouldCreateHandoff(context)).toBe(false);
  });

  it("should create handoff on watchdog trigger", () => {
    const context: TriggerContext = {
      source: "watchdog",
      severity: "warning",
    };
    
    expect(shouldCreateHandoff(context)).toBe(true);
  });

  it("should create handoff on manual escalation", () => {
    const context: TriggerContext = {
      source: "manual_escalation",
      severity: "warning",
    };
    
    expect(shouldCreateHandoff(context)).toBe(true);
  });

  it("should create handoff on critical DLQ overflow", () => {
    const context: TriggerContext = {
      source: "dlq_overflow",
      severity: "critical",
    };
    
    expect(shouldCreateHandoff(context)).toBe(true);
  });

  it("should not create handoff on non-critical DLQ overflow", () => {
    const context: TriggerContext = {
      source: "dlq_overflow",
      severity: "warning",
    };
    
    expect(shouldCreateHandoff(context)).toBe(false);
  });
});

describe("Escalation Triggers - shouldNotify", () => {
  it("should notify on all triggers by default", () => {
    const sources: TriggerContext["source"][] = [
      "policy_denial",
      "watchdog",
      "dlq_overflow",
      "orchestration_failure",
      "manual_escalation",
      "policy_approval_timeout",
    ];
    
    for (const source of sources) {
      expect(shouldNotify({ source })).toBe(true);
    }
  });

  it("should respect notification policy settings", () => {
    configureEscalationPolicy({ notifyOnPolicyDenial: false });
    
    expect(shouldNotify({ source: "policy_denial" })).toBe(false);
    expect(shouldNotify({ source: "watchdog" })).toBe(true); // Still enabled
  });
});

describe("Escalation Triggers - Integration", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    resetEscalationPolicy();
    resetTriggerIntegration();
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();

    // Disable rate limits for testing
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should handle policy denial trigger", async () => {
    const action = await handlePolicyDenial(
      "evt-123",
      "Bash",
      "Security policy violation",
      { severity: "warning", channelId: "telegram:123" }
    );
    
    expect(action.pause).toBe(false); // Not critical
    expect(action.handoff).toBe(true);
    expect(action.notification).toBe(true);
    expect(action.notificationType).toBe("policy_denial");
  });

  it("should pause on critical policy denial", async () => {
    const action = await handlePolicyDenial(
      "evt-456",
      "Edit",
      "Critical security violation",
      { severity: "critical" }
    );
    
    expect(action.pause).toBe(true);
    expect(action.pauseMode).toBe("admission_and_scheduling");
    
    // Verify pause state
    const pauseState = await getPauseState();
    expect(pauseState.paused).toBe(true);
  });

  it("should handle watchdog trigger", async () => {
    const decision: WatchdogDecision = {
      invocationId: "inv-123",
      state: "suspend",
      reason: "Too many tool calls",
      triggeredLimits: ["maxToolCalls"],
      recommendedAction: "pause",
      evaluatedAt: new Date().toISOString(),
    };
    
    const action = await handleWatchdogTrigger(decision, {
      invocationId: "inv-123",
      sessionId: "session-456",
    });
    
    expect(action.pause).toBe(true);
    expect(action.handoff).toBe(true);
    expect(action.notification).toBe(true);
  });

  it("should handle DLQ overflow trigger", async () => {
    const action = await handleDlqOverflow(150, 100, {
      eventId: "evt-789",
      workflowId: "wf-abc",
    });
    
    expect(action.notification).toBe(true);
    // Not critical, so no handoff
    expect(action.handoff).toBe(false);
  });

  it("should handle critical DLQ overflow", async () => {
    const action = await handleDlqOverflow(300, 100, {
      eventId: "evt-critical",
    });
    
    expect(action.notification).toBe(true);
    expect(action.handoff).toBe(true); // Critical creates handoff
  });

  it("should track repeated orchestration failures", async () => {
    const workflowId = "wf-repeated";
    
    // First two failures should not pause
    await handleOrchestrationFailure(workflowId, "Error 1");
    await handleOrchestrationFailure(workflowId, "Error 2");
    
    const counts = getFailureCounts();
    expect(counts[workflowId].count).toBe(2);
    
    // Third failure should trigger pause
    const action = await handleOrchestrationFailure(workflowId, "Error 3");
    expect(action.pause).toBe(true);
  });

  it("should handle manual escalation", async () => {
    const action = await handleManualEscalation(
      "Operator needs assistance",
      { severity: "warning", workflowId: "wf-help" }
    );
    
    expect(action.pause).toBe(false); // Manual doesn't auto-pause
    expect(action.handoff).toBe(true);
    expect(action.notification).toBe(true);
  });

  it("should create handoffs with correct context", async () => {
    await handleManualEscalation("Test", {
      workflowId: "wf-test",
      sessionId: "session-test",
      channelId: "telegram:123",
    });
    
    const handoffs = await listHandoffs();
    expect(handoffs.length).toBeGreaterThanOrEqual(1);
    
    const handoff = handoffs.find(h => h.reason.includes("Test"));
    expect(handoff).toBeDefined();
  });

  it("should generate audit log entries", async () => {
    const action = await handleEscalationTrigger({
      source: "manual_escalation",
      severity: "warning",
      message: "Audit test",
    });
    
    expect(action.actionId).toBeDefined();
    expect(action.timestamp).toBeDefined();
  });
});

describe("Escalation Triggers - Failure Count Management", () => {
  beforeEach(() => {
    resetEscalationPolicy();
    clearFailureCount("test-workflow");
  });

  it("should track failure counts per workflow", () => {
    const workflowId = "test-workflow";
    
    clearFailureCount(workflowId);
    
    // Simulate failures
    const context1: TriggerContext = { source: "orchestration_failure", workflowId };
    const context2: TriggerContext = { source: "orchestration_failure", workflowId };
    
    shouldPause({ ...context1, severity: "warning" });
    shouldPause({ ...context2, severity: "warning" });
    
    const counts = getFailureCounts();
    expect(counts[workflowId].count).toBe(2);
  });

  it("should clear failure counts", () => {
    const workflowId = "test-workflow";
    
    shouldPause({ source: "orchestration_failure", workflowId, severity: "warning" });
    clearFailureCount(workflowId);
    
    const counts = getFailureCounts();
    expect(counts[workflowId]).toBeUndefined();
  });

  it("should reset failure counts with policy", () => {
    const workflowId = "test-workflow";
    
    shouldPause({ source: "orchestration_failure", workflowId, severity: "warning" });
    resetEscalationPolicy();
    
    const counts = getFailureCounts();
    expect(Object.keys(counts).length).toBe(0);
  });
});

describe("Escalation Triggers - Pause Mode Determination", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    resetEscalationPolicy();
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should use admission_and_scheduling for critical severity", async () => {
    await handlePolicyDenial("evt-1", "Bash", "Critical", { severity: "critical" });
    
    const state = await getPauseState();
    expect(state.mode).toBe("admission_and_scheduling");
  });

  it("should use admission_only for warning severity", async () => {
    // Disable auto-pause for critical to test warning
    configureEscalationPolicy({ pauseOnCriticalPolicyDenial: false });
    
    // Create a watchdog suspend (which pauses)
    const decision: WatchdogDecision = {
      invocationId: "inv-1",
      state: "suspend",
      reason: "Test",
      triggeredLimits: [],
      recommendedAction: "pause",
      evaluatedAt: new Date().toISOString(),
    };
    
    await handleWatchdogTrigger(decision, { invocationId: "inv-1" });
    
    const state = await getPauseState();
    expect(state.mode).toBe("admission_only");
  });
});
