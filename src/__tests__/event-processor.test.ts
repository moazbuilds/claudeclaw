/**
 * Tests for event-processor.ts
 * 
 * Run with: bun test src/__tests__/event-processor.test.ts
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
  initProcessor,
  processNext,
  processPending,
  getPendingCount,
  getLastProcessedSeq,
  getDedupeStats,
  hasDedupeKey,
  resetProcessor,
  type ProcessingResult,
} from "../event-processor";

const TEST_DIR = join(process.cwd(), ".claude", "claudeclaw");

beforeEach(async () => {
  // Reset module state
  resetEventLog();
  
  // Clean up test directories
  await rm(join(TEST_DIR, "event-log"), { recursive: true, force: true });
  await rm(join(TEST_DIR, "dedupe"), { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "event-log"), { recursive: true });
  await mkdir(join(TEST_DIR, "dedupe"), { recursive: true });
  
  await resetProcessor();
});

afterEach(async () => {
  await rm(join(TEST_DIR, "event-log"), { recursive: true, force: true });
  await rm(join(TEST_DIR, "dedupe"), { recursive: true, force: true });
});

const createTestEntry = (overrides: Partial<EventEntryInput> = {}): EventEntryInput => ({
  type: "test",
  source: "test-source",
  channelId: "test-channel",
  threadId: "test-thread",
  payload: { message: "hello" },
  dedupeKey: `test-${Date.now()}-${Math.random()}`,
  ...overrides,
});

describe("Event Processor", () => {
  it("should initialize processor", async () => {
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => ({ success: true }),
    });

    const stats = getDedupeStats();
    expect(stats.totalEntries).toBe(0);
    expect(stats.retentionDays).toBe(7);
  });

  it("should process a single event", async () => {
    let processed = false;
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async (event) => {
        processed = true;
        expect(event.type).toBe("test");
        return { success: true };
      },
    });

    await append(createTestEntry());
    const didProcess = await processNext();

    expect(didProcess).toBe(true);
    expect(processed).toBe(true);
  });

  it("should process multiple events in order", async () => {
    const processedSeqs: number[] = [];
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async (event) => {
        processedSeqs.push(event.seq);
        return { success: true };
      },
    });

    await append(createTestEntry());
    await append(createTestEntry());
    await append(createTestEntry());

    const count = await processPending();

    expect(count).toBe(3);
    expect(processedSeqs).toEqual([1, 2, 3]);
  });

  it("should deduplicate events by dedupeKey", async () => {
    let processCount = 0;
    const dedupeKey = "unique-key-123";
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => {
        processCount++;
        return { success: true };
      },
    });

    // Append two events with same dedupe key
    await append(createTestEntry({ dedupeKey }));
    await append(createTestEntry({ dedupeKey }));

    await processPending();

    expect(processCount).toBe(1);
    expect(hasDedupeKey(dedupeKey)).toBe(true);
  });

  it("should handle event failure with retry", async () => {
    let attempts = 0;
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => {
        attempts++;
        return { 
          success: false, 
          error: "Temporary error",
          shouldRetry: true 
        };
      },
    });

    const entry = await append(createTestEntry());
    await processNext();

    expect(attempts).toBe(1);
    // Event should be marked for retry
    // (Full retry logic tested in retry-queue.test.ts)
  });

  it("should handle permanent failure", async () => {
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => ({
        success: false,
        error: "Permanent error",
        shouldRetry: false,
      }),
    });

    const entry = await append(createTestEntry());
    await processNext();

    // Event should be marked dead_lettered
    // (DLQ logic tested in dead-letter-queue.test.ts)
  });

  it("should get pending count", async () => {
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => ({ success: true }),
    });

    await append(createTestEntry());
    await append(createTestEntry());

    const pendingBefore = await getPendingCount();
    expect(pendingBefore).toBe(2);

    await processNext();

    const pendingAfter = await getPendingCount();
    expect(pendingAfter).toBe(1);
  });

  it("should track last processed sequence", async () => {
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => ({ success: true }),
    });

    expect(getLastProcessedSeq()).toBe(0);

    await append(createTestEntry());
    await processNext();

    expect(getLastProcessedSeq()).toBe(1);
  });

  it("should use canonical dedupe key when dedupeKey not provided", async () => {
    let processCount = 0;
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => {
        processCount++;
        return { success: true };
      },
    });

    // Same payload, no dedupeKey - should generate same canonical key
    const payload = { action: "test", data: "same" };
    await append(createTestEntry({ payload, dedupeKey: "" }));
    await append(createTestEntry({ payload, dedupeKey: "" }));

    await processPending();

    expect(processCount).toBe(1);
  });

  it("should survive restart", async () => {
    const dedupeKey = "restart-test-key";
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => ({ success: true }),
    });

    await append(createTestEntry({ dedupeKey }));
    await processNext();

    expect(hasDedupeKey(dedupeKey)).toBe(true);

    // Simulate restart by reinitializing
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => ({ success: true }),
    });

    // Should still recognize the dedupe key
    expect(hasDedupeKey(dedupeKey)).toBe(true);
  });
});

describe("Event Processor - Edge Cases", () => {
  it("should handle processor errors gracefully", async () => {
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => {
        throw new Error("Processor crash");
      },
    });

    await append(createTestEntry());
    
    // Should not throw
    await processNext();
  });

  it("should not process when already processing", async () => {
    let processing = false;
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async () => {
        processing = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        processing = false;
        return { success: true };
      },
    });

    await append(createTestEntry());

    // Start first process
    const p1 = processNext();
    
    // Try to start second while first is running
    const p2 = processNext();

    const [r1, r2] = await Promise.all([p1, p2]);
    
    // Only one should have processed
    expect(r1 || r2).toBe(true);
    expect(r1 && r2).toBe(false);
  });

  it("should handle different event types", async () => {
    const types: string[] = [];
    
    await initProcessor({
      retentionDays: 7,
      onEvent: async (event) => {
        types.push(event.type);
        return { success: true };
      },
    });

    await append(createTestEntry({ type: "type-a" }));
    await append(createTestEntry({ type: "type-b" }));
    await append(createTestEntry({ type: "type-c" }));

    await processPending();

    expect(types).toEqual(["type-a", "type-b", "type-c"]);
  });
});
