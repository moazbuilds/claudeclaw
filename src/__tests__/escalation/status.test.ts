/**
 * Tests for escalation/status.ts
 * 
 * Run with: bun test src/__tests__/escalation/status.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getEscalationStatus,
  getEscalationSummary,
  requiresAttention,
  formatStatus,
  exportStatusAsJson,
} from "../../escalation/status";
import { pause, resume, resetPauseController } from "../../escalation/pause";
import { createHandoff, acceptHandoff, closeHandoff, resetHandoffManager } from "../../escalation/handoff";
import { notify, resetNotificationManager } from "../../escalation/notifications";

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");

describe("Escalation Status - Basic Operations", () => {
  beforeEach(async () => {
    // Clean directories before test to ensure isolation
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "pause-actions.jsonl"), { force: true });
      await rm(join(ESCALATION_DIR, "paused.json"), { force: true });
    } catch {
      // Ignore cleanup errors
    }
    
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();
    
    // Disable rate limits for testing
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should get escalation status when empty", async () => {
    const status = await getEscalationStatus();
    
    expect(status.timestamp).toBeDefined();
    expect(status.pause.paused).toBe(false);
    expect(status.handoffs).toHaveLength(0);
    expect(status.notifications).toHaveLength(0);
    expect(status.summary.totalHandoffs).toBe(0);
    expect(status.summary.isPaused).toBe(false);
  });

  it("should include pause status when paused", async () => {
    await pause("admission_only", { reason: "Test pause", pausedBy: "operator" });
    
    const status = await getEscalationStatus();
    
    expect(status.pause.paused).toBe(true);
    expect(status.pause.mode).toBe("admission_only");
    expect(status.pause.reason).toBe("Test pause");
    expect(status.pause.pausedBy).toBe("operator");
    expect(status.summary.isPaused).toBe(true);
  });

  it("should include handoffs in status", async () => {
    await createHandoff("Test handoff", { source: "telegram" }, { severity: "warning" });
    
    const status = await getEscalationStatus();
    
    expect(status.handoffs).toHaveLength(1);
    expect(status.handoffs[0].reason).toBe("Test handoff");
    expect(status.handoffs[0].status).toBe("open");
    expect(status.handoffs[0].severity).toBe("warning");
    expect(status.summary.totalHandoffs).toBe(1);
    expect(status.summary.openHandoffs).toBe(1);
  });

  it("should include notifications in status", async () => {
    await notify("dlq_overflow", "warning", "DLQ is filling up");
    
    const status = await getEscalationStatus();
    
    expect(status.notifications).toHaveLength(1);
    expect(status.notifications[0].type).toBe("dlq_overflow");
    expect(status.notifications[0].severity).toBe("warning");
  });

  it("should count critical handoffs correctly", async () => {
    await createHandoff("Critical handoff", {}, { severity: "critical" });
    await createHandoff("Warning handoff", {}, { severity: "warning" });
    
    const status = await getEscalationStatus();
    
    expect(status.summary.criticalHandoffs).toBe(1);
  });

  it("should not count closed handoffs as critical", async () => {
    const handoff = await createHandoff("Critical handoff", {}, { severity: "critical" });
    await closeHandoff(handoff.handoffId, { closedBy: "operator" });
    
    const status = await getEscalationStatus();
    
    expect(status.summary.criticalHandoffs).toBe(0);
    expect(status.summary.openHandoffs).toBe(0);
  });
});

describe("Escalation Status - Filtering", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();
    
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should respect handoff limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createHandoff(`Handoff ${i}`);
    }
    
    const status = await getEscalationStatus({ handoffLimit: 3 });
    
    expect(status.handoffs).toHaveLength(3);
  });

  it("should respect notification limit", async () => {
    for (let i = 0; i < 5; i++) {
      await notify("dlq_overflow", "info", `Message ${i}`);
    }
    
    const status = await getEscalationStatus({ notificationLimit: 3 });
    
    expect(status.notifications).toHaveLength(3);
  });

  it("should include closed handoffs when requested", async () => {
    const h1 = await createHandoff("Open handoff");
    const h2 = await createHandoff("Closed handoff");
    await closeHandoff(h2.handoffId, {});
    
    const statusWithClosed = await getEscalationStatus({ includeClosedHandoffs: true });
    const statusWithoutClosed = await getEscalationStatus({ includeClosedHandoffs: false });
    
    expect(statusWithClosed.handoffs).toHaveLength(2);
    expect(statusWithoutClosed.handoffs).toHaveLength(1);
  });

  it("should filter by since date", async () => {
    // Create an old handoff
    const oldHandoff = await createHandoff("Old handoff");
    
    // Wait a bit and create a new one
    await new Promise(r => setTimeout(r, 50));
    const since = new Date().toISOString();
    await new Promise(r => setTimeout(r, 50));
    
    await createHandoff("New handoff");
    
    const status = await getEscalationStatus({ since });
    
    expect(status.handoffs).toHaveLength(1);
    expect(status.handoffs[0].reason).toBe("New handoff");
  });
});

describe("Escalation Status - Summary", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();
    
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should get escalation summary", async () => {
    await pause("admission_only", { reason: "Test" });
    await createHandoff("Test handoff", {}, { severity: "critical" });
    await notify("dlq_overflow", "warning", "Test notification");
    
    const summary = await getEscalationSummary();
    
    expect(summary.isPaused).toBe(true);
    expect(summary.totalHandoffs).toBe(1);
    expect(summary.criticalHandoffs).toBe(1);
    expect(summary.openHandoffs).toBe(1);
  });

  it("should count notifications from last 24 hours", async () => {
    await notify("dlq_overflow", "info", "Recent notification");
    
    const summary = await getEscalationSummary();
    
    expect(summary.totalNotifications24h).toBeGreaterThanOrEqual(1);
  });
});

describe("Escalation Status - Requires Attention", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();
    
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should not require attention when system is healthy", async () => {
    const result = await requiresAttention();
    
    expect(result.requiresAttention).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("should require attention when paused", async () => {
    await pause("admission_only", { reason: "Maintenance" });
    
    const result = await requiresAttention();
    
    expect(result.requiresAttention).toBe(true);
    expect(result.reasons.some(r => r.includes("paused"))).toBe(true);
  });

  it("should require attention with critical handoffs", async () => {
    await createHandoff("Critical issue", {}, { severity: "critical" });
    
    const result = await requiresAttention();
    
    expect(result.requiresAttention).toBe(true);
    expect(result.reasons.some(r => r.includes("critical"))).toBe(true);
  });
});

describe("Escalation Status - Formatting", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();
    
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should format status as human-readable string", async () => {
    await pause("admission_only", { reason: "Test" });
    await createHandoff("Test handoff");
    
    const status = await getEscalationStatus();
    const formatted = formatStatus(status);
    
    expect(formatted).toContain("ESCALATION STATUS");
    expect(formatted).toContain("PAUSE STATUS");
    expect(formatted).toContain("SYSTEM IS PAUSED");
    expect(formatted).toContain("HANDOFFS");
    expect(formatted).toContain("Test handoff");
    expect(formatted).toContain("SUMMARY");
  });

  it("should format running status correctly", async () => {
    const status = await getEscalationStatus();
    const formatted = formatStatus(status);
    
    expect(formatted).toContain("System is running normally");
  });

  it("should export status as JSON", async () => {
    await createHandoff("Test");
    
    const status = await getEscalationStatus();
    const json = exportStatusAsJson(status);
    
    const parsed = JSON.parse(json);
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.pause).toBeDefined();
    expect(parsed.handoffs).toBeDefined();
    expect(parsed.summary).toBeDefined();
  });
});

describe("Escalation Status - Recent Actions", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await mkdir(join(ESCALATION_DIR, "handoffs"), { recursive: true });
    await mkdir(join(ESCALATION_DIR, "notifications"), { recursive: true });
    await resetPauseController();
    await resetHandoffManager();
    await resetNotificationManager();
    
    const { configure } = await import("../../escalation/notifications");
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(join(ESCALATION_DIR, "handoffs"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "notifications"), { recursive: true, force: true });
      await rm(join(ESCALATION_DIR, "pause-actions.jsonl"), { force: true });
      await rm(join(ESCALATION_DIR, "handoff-actions.jsonl"), { force: true });
    } catch {
      // Ignore
    }
  });

  it("should include pause actions in recent actions", async () => {
    await pause("admission_only", { reason: "Test" });
    await resume({ reason: "Done" });
    
    const status = await getEscalationStatus();
    
    expect(status.recentActions.length).toBeGreaterThanOrEqual(2);
    expect(status.recentActions.some(a => a.action === "pause")).toBe(true);
    expect(status.recentActions.some(a => a.action === "resume")).toBe(true);
  });

  it("should include handoff actions in recent actions", async () => {
    const handoff = await createHandoff("Test handoff");
    await acceptHandoff(handoff.handoffId, { acceptedBy: "operator" });
    
    const status = await getEscalationStatus();
    
    expect(status.recentActions.some(a => a.action === "handoff_created")).toBe(true);
    expect(status.recentActions.some(a => a.action === "handoff_accepted")).toBe(true);
  });

  it("should respect action limit", async () => {
    await pause("admission_only", { reason: "Test 1" });
    await resume({ reason: "Done 1" });
    await pause("admission_only", { reason: "Test 2" });
    await resume({ reason: "Done 2" });
    
    const status = await getEscalationStatus({ actionLimit: 2 });
    
    expect(status.recentActions).toHaveLength(2);
  });
});
