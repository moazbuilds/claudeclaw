/**
 * Tests for session-map.ts
 * 
 * Run with: bun test src/__tests__/gateway/session-map.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "fs/promises";
import { join } from "path";
import {
  get,
  set,
  remove,
  update,
  updateLastSeq,
  incrementTurnCount,
  attachClaudeSessionId,
  getOrCreateMapping,
  listChannels,
  listThreads,
  markStale,
  cleanup,
  resetSessionMap,
  getWriteQueueLength,
  type SessionEntry,
  DEFAULT_THREAD_ID,
} from "../../gateway/session-map";

const TEST_SESSION_MAP_FILE = join(process.cwd(), ".claude", "claudeclaw", "session-map.json");

// Helper to create a test entry
const createTestEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  mappingId: "test-mapping-id",
  claudeSessionId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
  lastSeq: 0,
  turnCount: 0,
  status: "pending",
  ...overrides,
});

describe("Session Map - Core CRUD", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should return null for missing mapping", async () => {
    const result = await get("channel-1", "thread-1");
    expect(result).toBeNull();
  });

  it("should set and get the same entry", async () => {
    const entry = createTestEntry();
    await set("channel-1", "thread-1", entry);
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.mappingId).toBe(entry.mappingId);
    expect(retrieved?.claudeSessionId).toBeNull();
  });

  it("should delete only the targeted thread mapping", async () => {
    const entry1 = createTestEntry({ mappingId: "entry-1" });
    const entry2 = createTestEntry({ mappingId: "entry-2" });
    
    await set("channel-1", "thread-1", entry1);
    await set("channel-1", "thread-2", entry2);
    await set("channel-2", "thread-1", entry1);
    
    await remove("channel-1", "thread-1");
    
    // thread-1 in channel-1 should be gone
    expect(await get("channel-1", "thread-1")).toBeNull();
    
    // thread-2 in channel-1 should still exist
    expect(await get("channel-1", "thread-2")).not.toBeNull();
    
    // thread-1 in channel-2 should still exist
    expect(await get("channel-2", "thread-1")).not.toBeNull();
  });

  it("should use default thread ID when not specified", async () => {
    const entry = createTestEntry();
    await set("channel-1", DEFAULT_THREAD_ID, entry);
    
    const retrieved = await get("channel-1");
    expect(retrieved?.mappingId).toBe(entry.mappingId);
  });

  it("should handle malformed JSON file gracefully", async () => {
    // Write malformed JSON
    await Bun.write(TEST_SESSION_MAP_FILE, "not valid json {{{");
    
    // Reset to force re-read
    resetSessionMap();
    
    // Should not throw, should return empty map
    const result = await get("channel-1", "thread-1");
    expect(result).toBeNull();
  });

  it("should handle missing file gracefully", async () => {
    // File doesn't exist - reset forces re-read
    resetSessionMap();
    
    // Should not throw, should return empty map
    const result = await get("channel-1", "thread-1");
    expect(result).toBeNull();
  });
});

describe("Session Map - Same Channel / Different Thread Isolation", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should have different mapping entries for same channel with different threads", async () => {
    const entry1 = createTestEntry({ mappingId: "id-1" });
    const entry2 = createTestEntry({ mappingId: "id-2" });
    
    await set("channel-1", "thread-1", entry1);
    await set("channel-1", "thread-2", entry2);
    
    const retrieved1 = await get("channel-1", "thread-1");
    const retrieved2 = await get("channel-1", "thread-2");
    
    expect(retrieved1?.mappingId).toBe("id-1");
    expect(retrieved2?.mappingId).toBe("id-2");
  });
});

describe("Session Map - Same Thread Repeat Lookup Consistency", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should return the same entry on repeated lookups", async () => {
    const entry = createTestEntry({ mappingId: "consistent-id" });
    await set("channel-1", "thread-1", entry);
    
    // Multiple reads
    const retrieved1 = await get("channel-1", "thread-1");
    const retrieved2 = await get("channel-1", "thread-1");
    const retrieved3 = await get("channel-1", "thread-1");
    
    expect(retrieved1?.mappingId).toBe("consistent-id");
    expect(retrieved2?.mappingId).toBe("consistent-id");
    expect(retrieved3?.mappingId).toBe("consistent-id");
  });
});

describe("Session Map - Metadata Updates", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should get or create mapping returning existing entry", async () => {
    const entry = createTestEntry({ mappingId: "existing-id" });
    await set("channel-1", "thread-1", entry);
    
    const retrieved = await getOrCreateMapping("channel-1", "thread-1");
    expect(retrieved.mappingId).toBe("existing-id");
  });

  it("should get or create mapping creating new entry with null claudeSessionId", async () => {
    const retrieved = await getOrCreateMapping("channel-1", "thread-1");
    
    expect(retrieved.mappingId).toBeTruthy();
    expect(retrieved.claudeSessionId).toBeNull();
    expect(retrieved.status).toBe("pending");
  });

  it("should attach real Claude session ID once available", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    
    await attachClaudeSessionId("channel-1", "thread-1", "claude-session-123");
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.claudeSessionId).toBe("claude-session-123");
    expect(retrieved?.status).toBe("active");
  });

  it("should not overwrite existing non-null Claude session ID without force", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await attachClaudeSessionId("channel-1", "thread-1", "claude-session-123");
    
    // Try to overwrite
    await attachClaudeSessionId("channel-1", "thread-1", "claude-session-456");
    
    // Should still be the original
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.claudeSessionId).toBe("claude-session-123");
  });

  it("should force overwrite when forced", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await attachClaudeSessionId("channel-1", "thread-1", "claude-session-123");
    
    // Force overwrite
    await attachClaudeSessionId("channel-1", "thread-1", "claude-session-456", true);
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.claudeSessionId).toBe("claude-session-456");
  });

  it("should update lastSeq", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await updateLastSeq("channel-1", "thread-1", 42);
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.lastSeq).toBe(42);
  });

  it("should increment turn count", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    
    await incrementTurnCount("channel-1", "thread-1");
    await incrementTurnCount("channel-1", "thread-1");
    await incrementTurnCount("channel-1", "thread-1");
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.turnCount).toBe(3);
  });

  it("should list all channels", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await getOrCreateMapping("channel-2", "thread-1");
    await getOrCreateMapping("channel-3", "thread-1");
    
    const channels = await listChannels();
    expect(channels).toContain("channel-1");
    expect(channels).toContain("channel-2");
    expect(channels).toContain("channel-3");
    expect(channels.length).toBe(3);
  });

  it("should list all threads for a channel", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await getOrCreateMapping("channel-1", "thread-2");
    await getOrCreateMapping("channel-1", "thread-3");
    await getOrCreateMapping("channel-2", "thread-1");
    
    const threads = await listThreads("channel-1");
    expect(threads).toContain("thread-1");
    expect(threads).toContain("thread-2");
    expect(threads).toContain("thread-3");
    expect(threads.length).toBe(3);
  });

  it("should mark entry as stale", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await markStale("channel-1", "thread-1");
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.status).toBe("stale");
  });
});

describe("Session Map - Concurrent Writes", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should serialize concurrent writes without corruption", async () => {
    // Create multiple entries concurrently
    const entries = Array.from({ length: 10 }, (_, i) => 
      createTestEntry({ mappingId: `concurrent-${i}` })
    );
    
    await Promise.all(
      entries.map((entry, i) => set(`channel-${i}`, `thread-1`, entry))
    );
    
    // All entries should be present and correct
    for (let i = 0; i < 10; i++) {
      const retrieved = await get(`channel-${i}`, "thread-1");
      expect(retrieved?.mappingId).toBe(`concurrent-${i}`);
    }
  });

  it("should complete concurrent writes without data loss", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => 
      createTestEntry({ mappingId: `concurrent-${i}` })
    );
    
    // Start concurrent writes
    await Promise.all(
      entries.map((entry, i) => set(`channel-${i}`, "thread-1", entry))
    );
    
    // All entries should be present and correct after concurrent writes
    for (let i = 0; i < 10; i++) {
      const retrieved = await get(`channel-${i}`, "thread-1");
      expect(retrieved?.mappingId).toBe(`concurrent-${i}`);
    }
    
    // Queue should be empty after
    expect(getWriteQueueLength()).toBe(0);
  });
});

describe("Session Map - Cleanup", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should preserve active entries during cleanup", async () => {
    await getOrCreateMapping("channel-1", "thread-1");
    await attachClaudeSessionId("channel-1", "thread-1", "claude-session-123");
    
    const removed = await cleanup(1); // 1 day TTL
    
    expect(removed).toBe(0);
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved).not.toBeNull();
  });

  it("should remove empty channels after cleanup", async () => {
    // Create entry
    await getOrCreateMapping("channel-1", "thread-1");
    
    // Delete it
    await remove("channel-1", "thread-1");
    
    // Cleanup should remove empty channel
    await cleanup(1);
    
    const channels = await listChannels();
    expect(channels).not.toContain("channel-1");
  });

  it("should not delete entries with null claudeSessionId that are recent", async () => {
    // Create entry (will have null claudeSessionId)
    await getOrCreateMapping("channel-1", "thread-1");
    
    // Very short TTL - but entry was just created
    const removed = await cleanup(1);
    
    expect(removed).toBe(0);
    expect(await get("channel-1", "thread-1")).not.toBeNull();
  });

  it("should delete reset entries that are old", async () => {
    // Create entry
    await getOrCreateMapping("channel-1", "thread-1");
    
    // Manually set to reset status (simulating an old reset entry)
    const entry = await get("channel-1", "thread-1");
    if (entry) {
      entry.status = "reset";
      entry.updatedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
      await set("channel-1", "thread-1", entry);
    }
    
    // Cleanup with 1 day TTL
    const removed = await cleanup(1);
    
    expect(removed).toBe(1);
    expect(await get("channel-1", "thread-1")).toBeNull();
  });
});

describe("Session Map - Edge Cases", () => {
  beforeEach(() => {
    resetSessionMap();
  });

  afterEach(async () => {
    resetSessionMap();
    try {
      await rm(TEST_SESSION_MAP_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should throw when updating non-existent entry", async () => {
    await expect(
      update("nonexistent", "thread", { status: "active" })
    ).rejects.toThrow();
  });

  it("should throw when attaching session ID to non-existent entry", async () => {
    await expect(
      attachClaudeSessionId("nonexistent", "thread", "session-123")
    ).rejects.toThrow();
  });

  it("should throw when incrementing turn count for non-existent entry", async () => {
    await expect(
      incrementTurnCount("nonexistent", "thread")
    ).rejects.toThrow();
  });

  it("should handle empty channel ID", async () => {
    const entry = createTestEntry();
    await set("", "thread-1", entry);
    
    const retrieved = await get("", "thread-1");
    expect(retrieved?.mappingId).toBe(entry.mappingId);
  });

  it("should handle empty thread ID", async () => {
    const entry = createTestEntry();
    await set("channel-1", "", entry);
    
    const retrieved = await get("channel-1", "");
    expect(retrieved?.mappingId).toBe(entry.mappingId);
  });

  it("should preserve metadata through updates", async () => {
    const entry = createTestEntry({
      metadata: { key: "value", nested: { deep: true } }
    });
    await set("channel-1", "thread-1", entry);
    
    await updateLastSeq("channel-1", "thread-1", 100);
    
    const retrieved = await get("channel-1", "thread-1");
    expect(retrieved?.metadata).toEqual({ key: "value", nested: { deep: true } });
  });
});
