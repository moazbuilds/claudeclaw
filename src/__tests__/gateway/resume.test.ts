import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm } from "fs/promises";
import { join } from "path";
import {
  getOrCreateSessionMapping,
  getResumeArgs,
  getResumeArgsForEvent,
  recordClaudeSessionId,
  updateSessionAfterProcessing,
  getSessionStats,
  resetSession,
  isSessionStale,
  shouldWarnCompact,
  DEFAULT_STALE_THRESHOLD_MS,
  COMPACT_WARNING_THRESHOLD_MS,
} from "../../gateway/resume";
import {
  resetSessionMap,
  getWriteQueueLength,
  get,
  type SessionEntry,
} from "../../gateway/session-map";
import type { NormalizedEvent } from "../../gateway/normalizer";

const SESSION_MAP_FILE = join(process.cwd(), ".claude", "claudeclaw", "session-map.json");

// Test helper to create a mock NormalizedEvent
function createMockEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "test-event-id",
    channel: "telegram",
    channelId: "telegram:123456",
    threadId: "default",
    userId: "123456",
    text: "Hello, world!",
    attachments: [],
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// Test helper to wait for write queue to drain
async function waitForWriteQueue(): Promise<void> {
  // Wait for write queue to empty
  while (getWriteQueueLength() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("resume.ts", () => {
  beforeEach(async () => {
    // Reset session map state
    resetSessionMap();
    // Wait for any pending writes to complete
    await waitForWriteQueue();
    // Clear persisted file to ensure clean state
    try {
      await rm(SESSION_MAP_FILE, { force: true });
    } catch {
      // File might not exist, ignore
    }
  });

  // ============ Task 1: Core lookup and resume argument logic ============

  describe("getOrCreateSessionMapping", () => {
    test("creates a new mapping when none exists", async () => {
      const channelId = "telegram:123";
      const threadId = "default";

      const entry = await getOrCreateSessionMapping(channelId, threadId);

      expect(entry).toBeDefined();
      expect(entry.mappingId).toBeDefined();
      expect(entry.claudeSessionId).toBeNull();
      expect(entry.channelId).toBeUndefined(); // Not stored at entry level
      expect(entry.threadId).toBeUndefined();
      expect(entry.status).toBe("pending");
      expect(entry.turnCount).toBe(0);
      expect(entry.lastSeq).toBe(0);
    });

    test("returns existing mapping when one exists", async () => {
      const channelId = "telegram:456";
      const threadId = "thread-1";

      // Create first time
      const first = await getOrCreateSessionMapping(channelId, threadId);
      
      // Get again - should return same mapping
      const second = await getOrCreateSessionMapping(channelId, threadId);

      expect(first.mappingId).toBe(second.mappingId);
    });

    test("new mapping starts with null claudeSessionId", async () => {
      const entry = await getOrCreateSessionMapping("discord:789", "default");
      expect(entry.claudeSessionId).toBeNull();
    });
  });

  describe("getResumeArgs", () => {
    test("new mapping returns empty args and canResume=false", async () => {
      const result = await getResumeArgs("telegram:111", "default");

      expect(result.args).toEqual([]);
      expect(result.canResume).toBe(false);
      expect(result.isNewMapping).toBe(true);
      expect(result.claudeSessionId).toBeNull();
    });

    test("existing mapping with null claudeSessionId returns empty args", async () => {
      const channelId = "telegram:222";
      const threadId = "default";

      // Create mapping but don't attach Claude session ID
      await getOrCreateSessionMapping(channelId, threadId);

      const result = await getResumeArgs(channelId, threadId);

      expect(result.args).toEqual([]);
      expect(result.canResume).toBe(false);
      expect(result.isNewMapping).toBe(false);
    });

    test("mapping with real claudeSessionId returns --resume args", async () => {
      const channelId = "telegram:333";
      const threadId = "default";
      const realSessionId = "abc-123-session-id";

      // Create mapping and attach real Claude session ID
      await getOrCreateSessionMapping(channelId, threadId);
      await recordClaudeSessionId(channelId, threadId, realSessionId);

      const result = await getResumeArgs(channelId, threadId);

      expect(result.args).toEqual(["--resume", realSessionId]);
      expect(result.canResume).toBe(true);
      expect(result.isNewMapping).toBe(false);
      expect(result.claudeSessionId).toBe(realSessionId);
    });

    test("different channels/threads have independent mappings", async () => {
      const channel1 = "telegram:100";
      const channel2 = "telegram:200";
      const thread1 = "default";
      const thread2 = "thread-a";

      await getOrCreateSessionMapping(channel1, thread1);
      await getOrCreateSessionMapping(channel2, thread2);

      const result1 = await getResumeArgs(channel1, thread1);
      const result2 = await getResumeArgs(channel2, thread2);

      expect(result1.mappingId).not.toBe(result2.mappingId);
    });
  });

  describe("getResumeArgsForEvent", () => {
    test("extracts channelId and threadId from event", async () => {
      const event = createMockEvent({
        channelId: "discord:guild:123:456",
        threadId: "789",
      });

      const result = await getResumeArgsForEvent(event);

      expect(result.canResume).toBe(false);
      expect(result.isNewMapping).toBe(true);
    });

    test("returns resume args when event's session has real Claude session ID", async () => {
      const event = createMockEvent({
        channelId: "telegram:999",
        threadId: "default",
      });

      // Create mapping first, then record the session ID
      await getOrCreateSessionMapping(event.channelId, event.threadId);
      await recordClaudeSessionId(event.channelId, event.threadId, "real-session-xyz");

      const result = await getResumeArgsForEvent(event);

      expect(result.args).toEqual(["--resume", "real-session-xyz"]);
      expect(result.canResume).toBe(true);
    });
  });

  // ============ Task 2: Post-processing metadata updates ============

  describe("recordClaudeSessionId", () => {
    test("records real Claude session ID on mapping", async () => {
      const channelId = "telegram:1000";
      const threadId = "default";
      const sessionId = "claude-session-abc";

      await getOrCreateSessionMapping(channelId, threadId);
      await recordClaudeSessionId(channelId, threadId, sessionId);

      const entry = await get(channelId, threadId);
      expect(entry?.claudeSessionId).toBe(sessionId);
      expect(entry?.status).toBe("active");
    });

    test("does not overwrite existing real session ID without force", async () => {
      const channelId = "telegram:1001";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await recordClaudeSessionId(channelId, threadId, "first-session");
      await recordClaudeSessionId(channelId, threadId, "second-session");

      const entry = await get(channelId, threadId);
      expect(entry?.claudeSessionId).toBe("first-session");
    });

    test("overwrites with force=true", async () => {
      const channelId = "telegram:1002";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await recordClaudeSessionId(channelId, threadId, "first-session");
      
      // Use internal attachClaudeSessionId with force
      const { attachClaudeSessionId } = await import("../../gateway/session-map");
      await attachClaudeSessionId(channelId, threadId, "second-session", true);

      const entry = await get(channelId, threadId);
      expect(entry?.claudeSessionId).toBe("second-session");
    });

    test("ignores empty session IDs", async () => {
      const channelId = "telegram:1003";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await recordClaudeSessionId(channelId, threadId, "");

      const entry = await get(channelId, threadId);
      expect(entry?.claudeSessionId).toBeNull();
    });
  });

  describe("updateSessionAfterProcessing", () => {
    test("updates lastSeq after processing", async () => {
      const channelId = "telegram:2000";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await updateSessionAfterProcessing(channelId, threadId, 42);

      const entry = await get(channelId, threadId);
      expect(entry?.lastSeq).toBe(42);
    });

    test("increments turnCount by default", async () => {
      const channelId = "telegram:2001";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      
      // Process multiple turns
      await updateSessionAfterProcessing(channelId, threadId, 1);
      await updateSessionAfterProcessing(channelId, threadId, 2);
      await updateSessionAfterProcessing(channelId, threadId, 3);

      const entry = await get(channelId, threadId);
      expect(entry?.turnCount).toBe(3);
    });

    test("respects custom turnCountIncrement", async () => {
      const channelId = "telegram:2002";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await updateSessionAfterProcessing(channelId, threadId, 1, { turnCountIncrement: 5 });

      const entry = await get(channelId, threadId);
      expect(entry?.turnCount).toBe(5);
    });

    test("updates pending status to active on first successful processing", async () => {
      const channelId = "telegram:2003";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      const initial = await get(channelId, threadId);
      expect(initial?.status).toBe("pending");

      await updateSessionAfterProcessing(channelId, threadId, 1);

      const entry = await get(channelId, threadId);
      expect(entry?.status).toBe("active");
    });

    test("can set custom status via options", async () => {
      const channelId = "telegram:2004";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await updateSessionAfterProcessing(channelId, threadId, 1, { status: "stale" });

      const entry = await get(channelId, threadId);
      expect(entry?.status).toBe("stale");
    });

    test("updates lastActiveAt timestamp", async () => {
      const channelId = "telegram:2005";
      const threadId = "default";
      const before = new Date().toISOString();

      await getOrCreateSessionMapping(channelId, threadId);
      await updateSessionAfterProcessing(channelId, threadId, 1);

      const entry = await get(channelId, threadId);
      expect(entry?.lastActiveAt >= before).toBe(true);
    });
  });

  describe("getSessionStats", () => {
    test("returns null for non-existent mapping", async () => {
      const stats = await getSessionStats("nonexistent:channel", "default");
      expect(stats).toBeNull();
    });

    test("returns comprehensive stats for existing mapping", async () => {
      const channelId = "telegram:3000";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await updateSessionAfterProcessing(channelId, threadId, 10);
      await recordClaudeSessionId(channelId, threadId, "session-xyz");

      const stats = await getSessionStats(channelId, threadId);

      expect(stats).not.toBeNull();
      expect(stats!.mappingId).toBeDefined();
      expect(stats!.claudeSessionId).toBe("session-xyz");
      expect(stats!.lastSeq).toBe(10);
      expect(stats!.turnCount).toBe(1);
      expect(stats!.canResume).toBe(true);
      expect(stats!.isStale).toBe(false);
    });

    test("marks session as stale when past threshold", async () => {
      const channelId = "telegram:3001";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      
      // Manually set lastActiveAt to past threshold
      const oldDate = new Date(Date.now() - DEFAULT_STALE_THRESHOLD_MS - 1000).toISOString();
      const { update } = await import("../../gateway/session-map");
      await update(channelId, threadId, { lastActiveAt: oldDate });

      const stats = await getSessionStats(channelId, threadId);
      expect(stats!.isStale).toBe(true);
    });
  });

  // ============ Task 3: Lifecycle helpers ============

  describe("resetSession", () => {
    test("removes the targeted mapping", async () => {
      const channelId = "telegram:4000";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await resetSession(channelId, threadId);

      const entry = await get(channelId, threadId);
      expect(entry).toBeNull();
    });

    test("handles non-existent mapping gracefully", async () => {
      await resetSession("nonexistent:channel", "default");
      // Should not throw
    });

    test("multiple resets are idempotent", async () => {
      const channelId = "telegram:4001";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      await resetSession(channelId, threadId);
      await resetSession(channelId, threadId); // Second reset should not throw

      const entry = await get(channelId, threadId);
      expect(entry).toBeNull();
    });
  });

  describe("isSessionStale", () => {
    test("returns true for non-existent mapping", async () => {
      const isStale = await isSessionStale("nonexistent:channel", "default");
      expect(isStale).toBe(true);
    });

    test("returns false for recently active session", async () => {
      const channelId = "telegram:5000";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      const isStale = await isSessionStale(channelId, threadId);

      expect(isStale).toBe(false);
    });

    test("respects custom threshold", async () => {
      const channelId = "telegram:5001";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      
      // Set lastActiveAt to 30 minutes ago
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { update } = await import("../../gateway/session-map");
      await update(channelId, threadId, { lastActiveAt: thirtyMinutesAgo });

      // 1 hour threshold = not stale
      const isStale1hr = await isSessionStale(channelId, threadId, 60 * 60 * 1000);
      expect(isStale1hr).toBe(false);

      // 15 minute threshold = stale
      const isStale15min = await isSessionStale(channelId, threadId, 15 * 60 * 1000);
      expect(isStale15min).toBe(true);
    });
  });

  describe("shouldWarnCompact", () => {
    test("returns false for non-existent mapping", async () => {
      const shouldWarn = await shouldWarnCompact("nonexistent:channel", "default");
      expect(shouldWarn).toBe(false);
    });

    test("returns false for fresh session", async () => {
      const channelId = "telegram:6000";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      const shouldWarn = await shouldWarnCompact(channelId, threadId);

      expect(shouldWarn).toBe(false);
    });

    test("returns true for long session with many turns", async () => {
      const channelId = "telegram:6001";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      
      // Set high turn count but keep active (within compact warning threshold)
      const { update } = await import("../../gateway/session-map");
      await update(channelId, threadId, { turnCount: 100 });

      const shouldWarn = await shouldWarnCompact(channelId, threadId);
      expect(shouldWarn).toBe(true);
    });

    test("returns false for long session with few turns", async () => {
      const channelId = "telegram:6002";
      const threadId = "default";

      await getOrCreateSessionMapping(channelId, threadId);
      
      // Set low turn count
      const { update } = await import("../../gateway/session-map");
      await update(channelId, threadId, { turnCount: 10 });

      const shouldWarn = await shouldWarnCompact(channelId, threadId);
      expect(shouldWarn).toBe(false);
    });
  });

  // ============ Full flow tests ============

  describe("full flow", () => {
    test("create mapping -> first success -> record Claude session ID -> later resume", async () => {
      const channelId = "telegram:7000";
      const threadId = "default";

      // Step 1: Create new mapping (should not be resumable)
      const step1 = await getResumeArgs(channelId, threadId);
      expect(step1.canResume).toBe(false);
      expect(step1.args).toEqual([]);
      expect(step1.isNewMapping).toBe(true);

      // Step 2: First processing - should update stats but still not resumable
      await updateSessionAfterProcessing(channelId, threadId, 1);
      const step2 = await getResumeArgs(channelId, threadId);
      expect(step2.canResume).toBe(false); // No real session ID yet
      expect(step2.args).toEqual([]);

      // Step 3: Runner returns real Claude session ID - record it
      const realSessionId = "claude-runner-session-123";
      await recordClaudeSessionId(channelId, threadId, realSessionId);

      // Step 4: Now resume should work
      const step4 = await getResumeArgs(channelId, threadId);
      expect(step4.canResume).toBe(true);
      expect(step4.args).toEqual(["--resume", realSessionId]);
      expect(step4.claudeSessionId).toBe(realSessionId);

      // Step 5: More processing - turn count increases
      await updateSessionAfterProcessing(channelId, threadId, 2);
      await updateSessionAfterProcessing(channelId, threadId, 3);

      // Step 6: Final state check
      const final = await getSessionStats(channelId, threadId);
      expect(final!.turnCount).toBe(3);
      expect(final!.lastSeq).toBe(3);
      expect(final!.canResume).toBe(true);
    });

    test("sequential event processing maintains consistency", async () => {
      const channelId = "telegram:8000";
      const threadId = "default";

      // Create initial mapping
      await getOrCreateSessionMapping(channelId, threadId);

      // Process multiple events sequentially (write queue serializes anyway)
      for (let i = 1; i <= 5; i++) {
        await updateSessionAfterProcessing(channelId, threadId, i);
      }

      const stats = await getSessionStats(channelId, threadId);
      // After 5 sequential updates, turnCount should be 5
      expect(stats!.turnCount).toBe(5);
      // lastSeq should be the last value processed
      expect(stats!.lastSeq).toBe(5);
    });
  });
});
