/**
 * Tests for event-log.ts
 * 
 * Run with: bun test src/__tests__/event-log.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readdir } from "fs/promises";
import { join } from "path";
import {
  initEventLog,
  append,
  readFrom,
  readRange,
  getLastSeq,
  getStats,
  appendStatusUpdate,
  type EventEntryInput,
} from "../event-log";

const TEST_DIR = join(process.cwd(), ".claude", "claudeclaw", "event-log-test");

// Override the event log directory for testing
const originalCwd = process.cwd();

// Test helper - available to all test suites
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
  // Create isolated test directory
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  
  // Reset module state by re-importing
  // Note: In real tests we'd need to clear the module cache
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("Event Log", () => {

  it("should initialize event log", async () => {
    await initEventLog();
    const stats = await getStats();
    expect(stats.totalSegments).toBeGreaterThanOrEqual(0);
    expect(stats.lastSeq).toBeGreaterThanOrEqual(0);
  });

  it("should append events with monotonic sequence numbers", async () => {
    await initEventLog();
    
    const entry1 = createTestEntry();
    const entry2 = createTestEntry();
    const entry3 = createTestEntry();

    const record1 = await append(entry1);
    const record2 = await append(entry2);
    const record3 = await append(entry3);

    expect(record1.seq).toBeLessThan(record2.seq);
    expect(record2.seq).toBeLessThan(record3.seq);
    expect(record3.seq - record1.seq).toBe(2);
  });

  it("should read events from a sequence number", async () => {
    await initEventLog();
    
    const entries = [
      createTestEntry(),
      createTestEntry(),
      createTestEntry(),
    ];

    const records = await Promise.all(entries.map(e => append(e)));
    const startSeq = records[1].seq;

    const readEvents: typeof records = [];
    for await (const event of readFrom(startSeq)) {
      readEvents.push(event);
    }

    expect(readEvents.length).toBe(2);
    expect(readEvents[0].seq).toBe(startSeq);
    expect(readEvents[1].seq).toBe(startSeq + 1);
  });

  it("should read events in a range", async () => {
    await initEventLog();
    
    const entries = [
      createTestEntry(),
      createTestEntry(),
      createTestEntry(),
      createTestEntry(),
      createTestEntry(),
    ];

    const records = await Promise.all(entries.map(e => append(e)));
    const startSeq = records[1].seq;
    const endSeq = records[3].seq;

    const readEvents: typeof records = [];
    for await (const event of readRange(startSeq, endSeq)) {
      readEvents.push(event);
    }

    expect(readEvents.length).toBe(3);
    expect(readEvents[0].seq).toBe(startSeq);
    expect(readEvents[2].seq).toBe(endSeq);
  });

  it("should maintain correct event status", async () => {
    await initEventLog();
    
    const entry = createTestEntry();
    const record = await append(entry);

    expect(record.status).toBe("pending");
    expect(record.retryCount).toBe(0);
    expect(record.nextRetryAt).toBeNull();
  });

  it("should assign unique IDs to events", async () => {
    await initEventLog();
    
    const entry1 = createTestEntry();
    const entry2 = createTestEntry();

    const record1 = await append(entry1);
    const record2 = await append(entry2);

    expect(record1.id).not.toBe(record2.id);
    expect(record1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("should preserve dedupe keys", async () => {
    await initEventLog();
    
    const dedupeKey = "my-unique-dedupe-key";
    const entry = createTestEntry({ dedupeKey });
    const record = await append(entry);

    expect(record.dedupeKey).toBe(dedupeKey);
  });

  it("should handle correlation and causation IDs", async () => {
    await initEventLog();
    
    const correlationId = "corr-123";
    const causationId = "cause-456";
    const replayedFromEventId = "orig-789";
    
    const entry = createTestEntry({
      correlationId,
      causationId,
      replayedFromEventId,
    });
    
    const record = await append(entry);

    expect(record.correlationId).toBe(correlationId);
    expect(record.causationId).toBe(causationId);
    expect(record.replayedFromEventId).toBe(replayedFromEventId);
  });

  it("should return correct statistics", async () => {
    await initEventLog();
    
    const initialStats = await getStats();
    const initialSeq = initialStats.lastSeq;

    await append(createTestEntry());
    await append(createTestEntry());
    await append(createTestEntry());

    const finalStats = await getStats();
    expect(finalStats.lastSeq).toBe(initialSeq + 3);
    expect(finalStats.totalEvents).toBe(initialSeq + 3);
  });

  it("should get last sequence number", async () => {
    await initEventLog();
    
    const initialSeq = await getLastSeq();
    
    await append(createTestEntry());
    const seq1 = await getLastSeq();
    
    await append(createTestEntry());
    const seq2 = await getLastSeq();

    expect(seq1).toBe(initialSeq + 1);
    expect(seq2).toBe(initialSeq + 2);
  });

  it("should support status updates as new events", async () => {
    await initEventLog();
    
    const entry = createTestEntry();
    const record = await append(entry);

    const update = await appendStatusUpdate(record.id, {
      status: "done",
      retryCount: 1,
    });

    expect(update.type).toBe("__status_update__");
    expect(update.causationId).toBe(record.id);
    expect(update.seq).toBeGreaterThan(record.seq);
  });

  it("should include timestamps", async () => {
    await initEventLog();
    
    const before = Date.now();
    const record = await append(createTestEntry());
    const after = Date.now();
    
    const recordTime = new Date(record.timestamp).getTime();

    expect(recordTime).toBeGreaterThanOrEqual(before);
    expect(recordTime).toBeLessThanOrEqual(after);
    expect(record.createdAt).toBe(record.timestamp);
    expect(record.updatedAt).toBe(record.timestamp);
  });

  it("should preserve complex payloads", async () => {
    await initEventLog();
    
    const complexPayload = {
      nested: { deep: { value: 123 } },
      array: [1, 2, 3],
      string: "test",
      number: 42,
      boolean: true,
      null: null,
    };

    const entry = createTestEntry({ payload: complexPayload });
    const record = await append(entry);

    expect(record.payload).toEqual(complexPayload);
  });

  it("should handle empty readFrom when seq is beyond last", async () => {
    await initEventLog();
    
    await append(createTestEntry());
    const lastSeq = await getLastSeq();

    const events: unknown[] = [];
    for await (const event of readFrom(lastSeq + 100)) {
      events.push(event);
    }

    expect(events.length).toBe(0);
  });

  it("should handle concurrent appends safely", async () => {
    await initEventLog();
    
    const entries = Array.from({ length: 10 }, () => createTestEntry());
    
    // Concurrent appends
    const promises = entries.map(e => append(e));
    const records = await Promise.all(promises);

    // All sequences should be unique and monotonic
    const seqs = records.map(r => r.seq).sort((a, b) => a - b);
    const uniqueSeqs = new Set(seqs);
    
    expect(uniqueSeqs.size).toBe(seqs.length);
    
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });
});

describe("Event Log - Recovery", () => {
  it("should rebuild state from disk after simulated restart", async () => {
    await initEventLog();
    
    // Add some events
    const entry1 = createTestEntry();
    const entry2 = createTestEntry();
    
    const record1 = await append(entry1);
    const record2 = await append(entry2);
    
    const lastSeqBefore = await getLastSeq();

    // Simulate restart by reinitializing
    // In real scenario, we'd clear module state
    await initEventLog();
    
    const lastSeqAfter = await getLastSeq();
    expect(lastSeqAfter).toBe(lastSeqBefore);

    // Should still be able to read events
    const events: typeof record1[] = [];
    for await (const event of readFrom(1)) {
      events.push(event);
    }
    
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Event Log - Edge Cases", () => {
  it("should handle special characters in payload", async () => {
    await initEventLog();
    
    const entry = createTestEntry({
      payload: {
        text: "Hello\nWorld\t! \"quoted\" and 'single'",
        unicode: "日本語 🎉 émojis",
        html: "<script>alert('xss')</script>",
      },
    });

    const record = await append(entry);
    expect(record.payload).toEqual(entry.payload);
  });

  it("should handle very long dedupe keys", async () => {
    await initEventLog();
    
    const longKey = "x".repeat(1000);
    const entry = createTestEntry({ dedupeKey: longKey });
    const record = await append(entry);

    expect(record.dedupeKey).toBe(longKey);
  });

  it("should handle empty thread and channel IDs", async () => {
    await initEventLog();
    
    const entry = createTestEntry({
      channelId: "",
      threadId: "",
    });

    const record = await append(entry);
    expect(record.channelId).toBe("");
    expect(record.threadId).toBe("");
  });
});
