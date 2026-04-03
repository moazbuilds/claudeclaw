/**
 * Tests for policy/approval-queue.ts
 * 
 * Run with: bun test src/__tests__/policy/approval-queue.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  enqueue,
  approve,
  deny,
  listPending,
  loadState,
  findByEventId,
  findById,
  isPending,
  getLoadedAt,
} from "../../policy/approval-queue";
import { loadRules, type ToolRequestContext, type PolicyDecision } from "../../policy/engine";

const APPROVAL_DIR = join(process.cwd(), ".claude", "claudeclaw");
const APPROVAL_QUEUE_FILE = join(APPROVAL_DIR, "approval-queue.jsonl");

// Helper to create a test request
const createRequest = (overrides: Partial<ToolRequestContext> = {}): ToolRequestContext => ({
  eventId: "test-event-" + Math.random().toString(36).slice(2),
  source: "telegram",
  channelId: "telegram:123",
  threadId: "thread-1",
  userId: "user-1",
  skillName: undefined,
  toolName: "Bash",
  toolArgs: {},
  sessionId: "session-1",
  claudeSessionId: null,
  timestamp: new Date().toISOString(),
  metadata: {},
  ...overrides,
});

// Helper to create a test decision
const createDecision = (overrides: Partial<PolicyDecision> = {}): PolicyDecision => ({
  requestId: "req-" + Math.random().toString(36).slice(2),
  action: "require_approval",
  reason: "Test approval required",
  evaluatedAt: new Date().toISOString(),
  ...overrides,
});

describe("Approval Queue - Enqueue", () => {
  beforeEach(async () => {
    await mkdir(APPROVAL_DIR, { recursive: true });
    await loadState();
    await loadRules();
  });

  afterEach(async () => {
    try {
      await rm(APPROVAL_QUEUE_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should enqueue a request for approval", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    const entry = await enqueue(request, decision);
    
    expect(entry).toBeDefined();
    expect(entry.id).toBeDefined();
    expect(entry.eventId).toBe(request.eventId);
    expect(entry.status).toBe("pending");
    expect(entry.request).toEqual(request);
    expect(entry.decision).toEqual(decision);
    expect(entry.requestedAt).toBeDefined();
  });

  it("should persist entry to queue file", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    const entry = await enqueue(request, decision);
    
    expect(existsSync(APPROVAL_QUEUE_FILE)).toBe(true);
    
    const content = await readFile(APPROVAL_QUEUE_FILE, "utf8");
    const lines = content.split("\n").filter(line => line.trim());
    
    const found = lines.some(line => {
      const parsed = JSON.parse(line);
      return parsed.id === entry.id;
    });
    expect(found).toBe(true);
  });

  it("should generate unique IDs for each entry", async () => {
    const request1 = createRequest();
    const request2 = createRequest();
    const decision = createDecision();
    
    const entry1 = await enqueue(request1, decision);
    const entry2 = await enqueue(request2, decision);
    
    expect(entry1.id).not.toBe(entry2.id);
  });

  it("should set default expiry time", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    const entry = await enqueue(request, decision);
    
    expect(entry.expiresAt).toBeDefined();
    
    const expiryDate = new Date(entry.expiresAt!);
    const now = new Date();
    const diffHours = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    
    expect(diffHours).toBeGreaterThan(23);
    expect(diffHours).toBeLessThan(25);
  });
});

describe("Approval Queue - Approve", () => {
  beforeEach(async () => {
    await mkdir(APPROVAL_DIR, { recursive: true });
    await loadState();
    await loadRules();
  });

  afterEach(async () => {
    try {
      await rm(APPROVAL_QUEUE_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should approve a pending request", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    const entry = await enqueue(request, decision);
    const result = await approve(request.eventId, "operator-1", "Looks good");
    
    expect(result).toBeDefined();
    expect(result?.status).toBe("approved");
    expect(result?.approvedBy).toBe("operator-1");
    expect(result?.approvedAt).toBeDefined();
    expect(result?.resolutionReason).toBe("Looks good");
  });

  it("should persist approval to queue file", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    await enqueue(request, decision);
    await approve(request.eventId, "operator-1");
    
    const content = await readFile(APPROVAL_QUEUE_FILE, "utf8");
    const lines = content.split("\n").filter(line => line.trim());
    
    // Find the approval entry
    const approvalLine = lines.find(line => {
      const parsed = JSON.parse(line);
      return parsed.eventId === request.eventId && parsed.status === "approved";
    });
    
    expect(approvalLine).toBeDefined();
  });

  it("should be idempotent for already approved requests", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    await enqueue(request, decision);
    const first = await approve(request.eventId, "operator-1", "First approval");
    const second = await approve(request.eventId, "operator-2", "Second approval");
    
    expect(first?.approvedBy).toBe("operator-1");
    expect(second?.approvedBy).toBe("operator-1"); // Should remain first approver
    expect(second?.resolutionReason).toBe("First approval");
  });

  it("should return null for non-existent event", async () => {
    const result = await approve("non-existent-event", "operator-1");
    expect(result).toBeNull();
  });
});

describe("Approval Queue - Deny", () => {
  beforeEach(async () => {
    await mkdir(APPROVAL_DIR, { recursive: true });
    await loadState();
    await loadRules();
  });

  afterEach(async () => {
    try {
      await rm(APPROVAL_QUEUE_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should deny a pending request", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    const entry = await enqueue(request, decision);
    const result = await deny(request.eventId, "operator-1", "Not allowed");
    
    expect(result).toBeDefined();
    expect(result?.status).toBe("denied");
    expect(result?.deniedBy).toBe("operator-1");
    expect(result?.deniedAt).toBeDefined();
    expect(result?.resolutionReason).toBe("Not allowed");
  });

  it("should be idempotent for already denied requests", async () => {
    const request = createRequest();
    const decision = createDecision();
    
    await enqueue(request, decision);
    const first = await deny(request.eventId, "operator-1", "First denial");
    const second = await deny(request.eventId, "operator-2", "Second denial");
    
    expect(first?.deniedBy).toBe("operator-1");
    expect(second?.deniedBy).toBe("operator-1"); // Should remain first denier
  });
});

describe("Approval Queue - List Pending", () => {
  beforeEach(async () => {
    await mkdir(APPROVAL_DIR, { recursive: true });
    await loadState();
    await loadRules();
  });

  afterEach(async () => {
    try {
      await rm(APPROVAL_QUEUE_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should list only pending requests", async () => {
    const request1 = createRequest();
    const request2 = createRequest();
    const request3 = createRequest();
    const decision = createDecision();
    
    await enqueue(request1, decision);
    await enqueue(request2, decision);
    await enqueue(request3, decision);
    
    await approve(request1.eventId, "operator-1");
    
    const pending = listPending();
    
    expect(pending).toHaveLength(2);
    expect(pending.every(e => e.status === "pending")).toBe(true);
  });

  it("should sort pending by oldest first", async () => {
    const decision = createDecision();
    
    const entry1 = await enqueue(createRequest({ eventId: "event-1" }), decision);
    await new Promise(resolve => setTimeout(resolve, 10));
    const entry2 = await enqueue(createRequest({ eventId: "event-2" }), decision);
    await new Promise(resolve => setTimeout(resolve, 10));
    const entry3 = await enqueue(createRequest({ eventId: "event-3" }), decision);
    
    const pending = listPending();
    
    expect(pending[0].eventId).toBe("event-1");
    expect(pending[1].eventId).toBe("event-2");
    expect(pending[2].eventId).toBe("event-3");
  });
});

describe("Approval Queue - Persistence", () => {
  afterEach(async () => {
    try {
      await rm(APPROVAL_QUEUE_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should recover state after restart", async () => {
    const decision = createDecision();
    
    // Create some entries
    await mkdir(APPROVAL_DIR, { recursive: true });
    await loadState();
    await loadRules();
    
    const entry1 = await enqueue(createRequest({ eventId: "restart-event-1" }), decision);
    const entry2 = await enqueue(createRequest({ eventId: "restart-event-2" }), decision);
    
    await approve(entry1.eventId, "operator-1");
    
    // Simulate restart - reload state from disk
    await loadState();
    
    // Should recover state
    const pending = listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].eventId).toBe("restart-event-2");
    
    const recoveredEntry2 = await findById(entry2.id);
    expect(recoveredEntry2).toBeDefined();
    expect(recoveredEntry2?.status).toBe("pending");
  });

  it("should find entry by eventId", async () => {
    const decision = createDecision();
    
    await mkdir(APPROVAL_DIR, { recursive: true });
    await loadState();
    await loadRules();
    
    const entry = await enqueue(createRequest({ eventId: "find-me-event" }), decision);
    
    const found = await findByEventId("find-me-event");
    expect(found).toBeDefined();
    expect(found?.id).toBe(entry.id);
  });
});
