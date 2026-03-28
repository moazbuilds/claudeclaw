/**
 * Tests for escalation/handoff.ts
 * 
 * Run with: bun test src/__tests__/escalation/handoff.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  initHandoffManager,
  createHandoff,
  getHandoff,
  listHandoffs,
  acceptHandoff,
  closeHandoff,
  getHandoffStats,
  resetHandoffManager,
  clearHandoffCache,
  type HandoffContext,
  type HandoffSeverity,
} from "../../escalation/handoff";

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const HANDOFFS_DIR = join(ESCALATION_DIR, "handoffs");

describe("Handoff Manager - Initialization", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should initialize with empty handoff index", async () => {
    await initHandoffManager();
    
    const handoffs = await listHandoffs();
    expect(handoffs).toHaveLength(0);
  });

  it("should create handoffs directory", async () => {
    await initHandoffManager();
    
    expect(existsSync(HANDOFFS_DIR)).toBe(true);
  });
});

describe("Handoff Manager - Create Handoff", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should create a basic handoff", async () => {
    const handoff = await createHandoff("Test handoff reason");
    
    expect(handoff.handoffId).toBeDefined();
    expect(handoff.reason).toBe("Test handoff reason");
    expect(handoff.severity).toBe("info");
    expect(handoff.status).toBe("open");
    expect(handoff.createdAt).toBeDefined();
  });

  it("should create handoff with context", async () => {
    const context: HandoffContext = {
      workflowIds: ["wf-1", "wf-2"],
      sessionId: "session-123",
      claudeSessionId: "claude-456",
      source: "telegram",
      channelId: "telegram:789",
      threadId: "thread-abc",
      relatedEventIds: ["evt-1", "evt-2"],
      pendingTasks: ["task-1", "task-2"],
      pendingApprovals: ["appr-1"],
      pendingEvents: [
        { eventId: "evt-1", type: "message", status: "pending" },
      ],
    };
    
    const handoff = await createHandoff("Handoff with context", context, {
      severity: "warning",
      summary: "Summary of the handoff",
    });
    
    expect(handoff.workflowIds).toEqual(["wf-1", "wf-2"]);
    expect(handoff.sessionId).toBe("session-123");
    expect(handoff.claudeSessionId).toBe("claude-456");
    expect(handoff.source).toBe("telegram");
    expect(handoff.channelId).toBe("telegram:789");
    expect(handoff.threadId).toBe("thread-abc");
    expect(handoff.relatedEventIds).toEqual(["evt-1", "evt-2"]);
    expect(handoff.pendingTasks).toEqual(["task-1", "task-2"]);
    expect(handoff.pendingApprovals).toEqual(["appr-1"]);
    expect(handoff.pendingEvents).toHaveLength(1);
    expect(handoff.severity).toBe("warning");
    expect(handoff.summary).toBe("Summary of the handoff");
  });

  it("should persist handoff to file", async () => {
    const handoff = await createHandoff("Persisted handoff");
    
    const filePath = join(HANDOFFS_DIR, `${handoff.handoffId}.json`);
    expect(existsSync(filePath)).toBe(true);
    
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    
    expect(parsed.reason).toBe("Persisted handoff");
    expect(parsed.status).toBe("open");
  });

  it("should add handoff to index", async () => {
    const handoff = await createHandoff("Indexed handoff");
    
    const handoffs = await listHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].handoffId).toBe(handoff.handoffId);
    expect(handoffs[0].reason).toBe("Indexed handoff");
  });
});

describe("Handoff Manager - Get Handoff", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should get handoff by ID", async () => {
    const created = await createHandoff("Get me");
    
    const retrieved = await getHandoff(created.handoffId);
    
    expect(retrieved).not.toBeNull();
    expect(retrieved!.handoffId).toBe(created.handoffId);
    expect(retrieved!.reason).toBe("Get me");
  });

  it("should return null for non-existent handoff", async () => {
    const retrieved = await getHandoff("non-existent-id");
    expect(retrieved).toBeNull();
  });

  it("should get full handoff details including context", async () => {
    const context: HandoffContext = {
      sessionId: "test-session",
      pendingTasks: ["task-a", "task-b"],
    };
    
    const created = await createHandoff("Full details", context);
    const retrieved = await getHandoff(created.handoffId);
    
    expect(retrieved!.sessionId).toBe("test-session");
    expect(retrieved!.pendingTasks).toEqual(["task-a", "task-b"]);
  });
});

describe("Handoff Manager - List Handoffs", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should list all handoffs sorted by createdAt descending", async () => {
    await createHandoff("First", { source: "telegram" });
    await new Promise(r => setTimeout(r, 10)); // Ensure different timestamps
    await createHandoff("Second", { source: "discord" });
    
    const handoffs = await listHandoffs();
    
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].reason).toBe("Second"); // Newest first
    expect(handoffs[1].reason).toBe("First");
  });

  it("should filter by status", async () => {
    const h1 = await createHandoff("Open handoff");
    const h2 = await createHandoff("Another open");
    await acceptHandoff(h2.handoffId, { acceptedBy: "operator" });
    
    const openHandoffs = await listHandoffs({ status: "open" });
    const acceptedHandoffs = await listHandoffs({ status: "accepted" });
    
    expect(openHandoffs).toHaveLength(1);
    expect(openHandoffs[0].handoffId).toBe(h1.handoffId);
    expect(acceptedHandoffs).toHaveLength(1);
    expect(acceptedHandoffs[0].handoffId).toBe(h2.handoffId);
  });

  it("should filter by severity", async () => {
    await createHandoff("Info", {}, { severity: "info" });
    await createHandoff("Warning", {}, { severity: "warning" });
    await createHandoff("Critical", {}, { severity: "critical" });
    
    const criticalHandoffs = await listHandoffs({ severity: "critical" });
    
    expect(criticalHandoffs).toHaveLength(1);
    expect(criticalHandoffs[0].reason).toBe("Critical");
  });

  it("should filter by source", async () => {
    await createHandoff("Telegram", { source: "telegram" });
    await createHandoff("Discord", { source: "discord" });
    
    const telegramHandoffs = await listHandoffs({ source: "telegram" });
    
    expect(telegramHandoffs).toHaveLength(1);
    expect(telegramHandoffs[0].reason).toBe("Telegram");
  });

  it("should filter by sessionId", async () => {
    await createHandoff("Session A", { sessionId: "session-a" });
    await createHandoff("Session B", { sessionId: "session-b" });
    
    const sessionAHandoffs = await listHandoffs({ sessionId: "session-a" });
    
    expect(sessionAHandoffs).toHaveLength(1);
    expect(sessionAHandoffs[0].reason).toBe("Session A");
  });

  it("should filter by date range", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000).toISOString();
    const tomorrow = new Date(now.getTime() + 86400000).toISOString();
    
    await createHandoff("Recent");
    
    const recentHandoffs = await listHandoffs({
      createdAfter: yesterday,
      createdBefore: tomorrow,
    });
    
    expect(recentHandoffs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Handoff Manager - Accept Handoff", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should accept an open handoff", async () => {
    const handoff = await createHandoff("Accept me");
    
    const accepted = await acceptHandoff(handoff.handoffId, {
      acceptedBy: "operator-1",
    });
    
    expect(accepted).not.toBeNull();
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.acceptedBy).toBe("operator-1");
    expect(accepted!.acceptedAt).toBeDefined();
  });

  it("should return null for non-existent handoff", async () => {
    const result = await acceptHandoff("non-existent", { acceptedBy: "op" });
    expect(result).toBeNull();
  });

  it("should not accept already accepted handoff", async () => {
    const handoff = await createHandoff("Already accepted");
    await acceptHandoff(handoff.handoffId, { acceptedBy: "operator-1" });
    
    // Try to accept again
    const secondAccept = await acceptHandoff(handoff.handoffId, {
      acceptedBy: "operator-2",
    });
    
    expect(secondAccept!.status).toBe("accepted");
    expect(secondAccept!.acceptedBy).toBe("operator-1"); // First acceptor wins
  });

  it("should update index when accepting", async () => {
    const handoff = await createHandoff("Update index");
    await acceptHandoff(handoff.handoffId, { acceptedBy: "op" });
    
    const handoffs = await listHandoffs({ status: "accepted" });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].handoffId).toBe(handoff.handoffId);
  });
});

describe("Handoff Manager - Close Handoff", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should close an open handoff", async () => {
    const handoff = await createHandoff("Close me");
    
    const closed = await closeHandoff(handoff.handoffId, {
      closedBy: "operator-1",
      resolution: "Issue resolved",
    });
    
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe("closed");
    expect(closed!.closedBy).toBe("operator-1");
    expect(closed!.resolution).toBe("Issue resolved");
    expect(closed!.closedAt).toBeDefined();
  });

  it("should close an accepted handoff", async () => {
    const handoff = await createHandoff("Close accepted");
    await acceptHandoff(handoff.handoffId, { acceptedBy: "op" });
    
    const closed = await closeHandoff(handoff.handoffId, {
      closedBy: "operator-2",
      resolution: "Done",
    });
    
    expect(closed!.status).toBe("closed");
  });

  it("should return null for non-existent handoff", async () => {
    const result = await closeHandoff("non-existent", { closedBy: "op" });
    expect(result).toBeNull();
  });

  it("should update index when closing", async () => {
    const handoff = await createHandoff("Update on close");
    await closeHandoff(handoff.handoffId, { closedBy: "op" });
    
    const handoffs = await listHandoffs({ status: "closed" });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].closedAt).toBeDefined();
  });
});

describe("Handoff Manager - Statistics", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should return correct statistics", async () => {
    // Create handoffs with different severities
    const h1 = await createHandoff("Info open", {}, { severity: "info" });
    await createHandoff("Warning open", {}, { severity: "warning" });
    const h3 = await createHandoff("Critical open", {}, { severity: "critical" });
    
    // Close one
    await closeHandoff(h1.handoffId, {});
    
    // Accept one
    await acceptHandoff(h3.handoffId, {});
    
    const stats = await getHandoffStats();
    
    expect(stats.total).toBe(3);
    expect(stats.byStatus.open).toBe(1);
    expect(stats.byStatus.accepted).toBe(1);
    expect(stats.byStatus.closed).toBe(1);
    expect(stats.bySeverity.info).toBe(1);
    expect(stats.bySeverity.warning).toBe(1);
    expect(stats.bySeverity.critical).toBe(1);
    expect(stats.openCritical).toBe(0); // The critical one was accepted
  });

  it("should count open critical handoffs", async () => {
    await createHandoff("Critical 1", {}, { severity: "critical" });
    await createHandoff("Critical 2", {}, { severity: "critical" });
    await createHandoff("Info", {}, { severity: "info" });
    
    const stats = await getHandoffStats();
    
    expect(stats.openCritical).toBe(2);
  });
});

describe("Handoff Manager - Persistence Across Restart", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should persist handoffs across cache clear (simulated restart)", async () => {
    const handoff = await createHandoff("Persist me", {
      sessionId: "test-session",
      source: "telegram",
    });
    
    // Simulate restart by clearing cache
    clearHandoffCache();
    
    // Should still be able to retrieve
    const retrieved = await getHandoff(handoff.handoffId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.reason).toBe("Persist me");
    expect(retrieved!.sessionId).toBe("test-session");
  });

  it("should persist handoff status changes", async () => {
    const handoff = await createHandoff("Status change");
    await acceptHandoff(handoff.handoffId, { acceptedBy: "op" });
    
    clearHandoffCache();
    
    const retrieved = await getHandoff(handoff.handoffId);
    expect(retrieved!.status).toBe("accepted");
    expect(retrieved!.acceptedBy).toBe("op");
  });
});

describe("Handoff Manager - Metadata Support", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetHandoffManager();
  });

  afterEach(async () => {
    try {
      await rm(HANDOFFS_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should store metadata on create", async () => {
    const handoff = await createHandoff("With metadata", {}, {
      metadata: { ticketId: "T-123", priority: "high" },
    });
    
    expect(handoff.metadata).toEqual({
      ticketId: "T-123",
      priority: "high",
    });
    
    const retrieved = await getHandoff(handoff.handoffId);
    expect(retrieved!.metadata).toEqual({
      ticketId: "T-123",
      priority: "high",
    });
  });

  it("should merge metadata on accept", async () => {
    const handoff = await createHandoff("Merge on accept", {}, {
      metadata: { original: "value" },
    });
    
    await acceptHandoff(handoff.handoffId, {
      acceptedBy: "op",
      metadata: { acceptedBy: "op", notes: "Working on it" },
    });
    
    const retrieved = await getHandoff(handoff.handoffId);
    expect(retrieved!.metadata).toEqual({
      original: "value",
      acceptedBy: "op",
      notes: "Working on it",
    });
  });

  it("should merge metadata on close", async () => {
    const handoff = await createHandoff("Merge on close", {}, {
      metadata: { original: "value" },
    });
    
    await closeHandoff(handoff.handoffId, {
      closedBy: "op",
      resolution: "Fixed",
      metadata: { closedAt: new Date().toISOString() },
    });
    
    const retrieved = await getHandoff(handoff.handoffId);
    expect(retrieved!.metadata).toEqual({
      original: "value",
      closedAt: expect.any(String),
    });
  });
});
