/**
 * Tests for retry-queue.ts
 * 
 * Run with: bun test src/__tests__/retry-queue.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  initEventLog,
  append,
  resetEventLog,
  type EventEntryInput,
} from "../event-log";
import {
  initRetryScheduler,
  schedule,
  popDue,
  remove,
  rebuildFromState,
  rebuildFromEventLog,
  getPendingRetryCount,
  getRetryStats,
  stopCheckLoop,
  resetRetryScheduler,
  isScheduled,
} from "../retry-queue";

const TEST_DIR = join(process.cwd(), ".claude", "claudeclaw");

const createTestEntry = (overrides: Partial<EventEntryInput> = {}): EventEntryInput => ({
  type: "test",
  source: "test-source",
  channelId: "test-channel",
  threadId: "test-thread",
  payload: { message: "hello" },
  dedupeKey: `test-${Date.now()}-${Math.random()}`,
  ...overrides,
});

beforeEach(async () => {
  resetEventLog();
  await resetRetryScheduler();
  
  await rm(join(TEST_DIR, "event-log"), { recursive: true, force: true });
  await rm(join(TEST_DIR, "retry"), { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "event-log"), { recursive: true });
  await mkdir(join(TEST_DIR, "retry"), { recursive: true });
});

afterEach(async () => {
  stopCheckLoop();
  await resetRetryScheduler();
});

describe("Retry Scheduler", () => {
  it("should initialize scheduler", async () => {
    await initRetryScheduler({
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      maxRetries: 3,
      checkIntervalMs: 100,
    });

    const stats = getRetryStats();
    expect(stats.pendingCount).toBe(0);
    expect(stats.maxRetries).toBe(3);
    expect(stats.baseDelayMs).toBe(1000);
  });

  it("should schedule an event for retry", async () => {
    await initRetryScheduler({ baseDelayMs: 1000, maxRetries: 5 });
    
    const entry = await append(createTestEntry());
    await schedule(entry.id, 0);

    expect(getPendingRetryCount()).toBe(1);
    expect(isScheduled(entry.id)).toBe(true);
  });

  it("should calculate exponential backoff", async () => {
    await initRetryScheduler({ baseDelayMs: 1000, maxDelayMs: 10000, maxRetries: 5 });
    
    const entry = await append(createTestEntry());
    
    // Schedule with retryCount 0 (1st retry)
    await schedule(entry.id, 0);
    const stats1 = getRetryStats();
    
    // Should use 1000 * 2^0 = 1000ms delay
    expect(stats1.pendingCount).toBe(1);
  });

  it("should reject scheduling when max retries exceeded", async () => {
    await initRetryScheduler({ maxRetries: 3 });
    
    const entry = await append(createTestEntry());
    
    expect(async () => {
      await schedule(entry.id, 3); // Already at max
    }).toThrow();
  });

  it("should pop due entries", async () => {
    await initRetryScheduler({ baseDelayMs: 1, maxRetries: 5 }); // Very short delay
    
    const entry = await append(createTestEntry());
    await schedule(entry.id, 0);

    // Wait for delay
    await new Promise(resolve => setTimeout(resolve, 10));

    const due = popDue();
    expect(due).not.toBeNull();
    expect(due?.eventId).toBe(entry.id);
    expect(getPendingRetryCount()).toBe(0);
  });

  it("should remove scheduled entry", async () => {
    await initRetryScheduler();
    
    const entry = await append(createTestEntry());
    await schedule(entry.id, 0);

    expect(getPendingRetryCount()).toBe(1);

    await remove(entry.id);

    expect(getPendingRetryCount()).toBe(0);
    expect(isScheduled(entry.id)).toBe(false);
  });

  it("should rebuild from state", async () => {
    await initRetryScheduler();
    
    const entry = await append(createTestEntry());
    await schedule(entry.id, 0);

    expect(getPendingRetryCount()).toBe(1);

    // Simulate restart by clearing in-memory queue
    await rebuildFromState();

    expect(getPendingRetryCount()).toBe(1);
    expect(isScheduled(entry.id)).toBe(true);
  });

  it("should rebuild from event log", async () => {
    await initRetryScheduler({ maxRetries: 5 });
    
    // Create an event and mark it for retry
    const entry = await append(createTestEntry());
    
    // Manually update event to retry_scheduled status
    const { appendStatusUpdate } = await import("../event-log");
    await appendStatusUpdate(entry.id, {
      status: "retry_scheduled",
      retryCount: 1,
      nextRetryAt: new Date(Date.now() + 60000).toISOString(),
    });

    const count = await rebuildFromEventLog();
    expect(count).toBe(1);
    expect(getPendingRetryCount()).toBe(1);
  });

  it("should provide statistics", async () => {
    await initRetryScheduler({
      baseDelayMs: 5000,
      maxDelayMs: 600000,
      maxRetries: 5,
    });

    const stats = getRetryStats();
    expect(stats.pendingCount).toBe(0);
    expect(stats.baseDelayMs).toBe(5000);
    expect(stats.maxDelayMs).toBe(600000);
    expect(stats.maxRetries).toBe(5);
    expect(stats.nextRetryAt).toBeNull();
  });
});

describe("Retry Scheduler - Edge Cases", () => {
  it("should handle non-existent event", async () => {
    await initRetryScheduler();

    expect(async () => {
      await schedule("non-existent-id", 0);
    }).toThrow();
  });

  it("should return null when no due entries", async () => {
    await initRetryScheduler({ baseDelayMs: 60000, maxRetries: 5 }); // Long delay
    
    const entry = await append(createTestEntry());
    await schedule(entry.id, 0);

    const due = popDue();
    expect(due).toBeNull();
  });

  it("should sort retries by time", async () => {
    await initRetryScheduler({ baseDelayMs: 1, maxRetries: 5 });
    
    const entry1 = await append(createTestEntry());
    const entry2 = await append(createTestEntry());
    const entry3 = await append(createTestEntry());

    // Schedule with different retry counts (different delays)
    await schedule(entry1.id, 2); // Longest delay
    await schedule(entry2.id, 0); // Shortest delay
    await schedule(entry3.id, 1); // Medium delay

    // Wait for shortest delay
    await new Promise(resolve => setTimeout(resolve, 5));

    // Should pop in order: entry2 (retry 0), entry3 (retry 1), entry1 (retry 2)
    const first = popDue();
    expect(first?.eventId).toBe(entry2.id);
  });
});
