/**
 * Session Map Store
 * 
 * Hierarchical per-channel+thread mapping state management.
 * Each channelId + threadId combination has its own isolated mapping entry.
 * 
 * PERSISTENCE MODEL:
 * - Data stored at .claude/claudeclaw/session-map.json
 * - Source of truth is the persisted file
 * - Write queue pattern serializes concurrent write operations
 * - Reads may be optimistic, writes are serialized
 * 
 * DESIGN CONSTRAINTS:
 * - Do NOT invent a Claude CLI session ID - store as null until real ID is returned
 * - Cleanup must not remove entries merely because they are old if still active
 * - Storage-focused module - do not fold resume logic into it
 */

import { join } from "path";
import { randomUUID } from "crypto";

const SESSION_MAP_FILE = join(process.cwd(), ".claude", "claudeclaw", "session-map.json");
const DEFAULT_THREAD_ID = "default";
const DEFAULT_TTL_DAYS = 30; // Entries older than this with no activity are cleanup candidates

export type SessionStatus = "pending" | "active" | "stale" | "reset";

export interface SessionEntry {
  mappingId: string;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  lastSeq: number;
  turnCount: number;
  status: SessionStatus;
  metadata?: Record<string, unknown>;
}

export interface SessionMap {
  [channelId: string]: {
    [threadId: string]: SessionEntry;
  };
}

// In-memory cache
let sessionMap: SessionMap | null = null;
let initializationPromise: Promise<void> | null = null;

// Write queue for serializing concurrent write operations
let writeQueue: Promise<void> = Promise.resolve();
let writeQueueLength = 0;

/**
 * Enqueue a write operation to ensure serial execution.
 * All writes to the session map must go through this queue.
 */
function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  writeQueueLength++;
  const promise = writeQueue.then(() => operation());
  writeQueue = promise.then(
    () => { writeQueueLength--; },
    () => { writeQueueLength--; }
  );
  return promise;
}

/**
 * Get the current length of the write queue (for testing/debugging).
 */
export function getWriteQueueLength(): number {
  return writeQueueLength;
}

/**
 * Reset session map state (for testing).
 * Clears in-memory cache and forces re-initialization.
 */
export function resetSessionMap(): void {
  sessionMap = null;
  initializationPromise = null;
  writeQueue = Promise.resolve();
  writeQueueLength = 0;
}

/**
 * Initialize the session map by loading from disk.
 */
async function initSessionMap(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  sessionMap = await loadMap();
}

/**
 * Load the session map from disk.
 * Missing or malformed files return empty map.
 */
async function loadMap(): Promise<SessionMap> {
  try {
    const content = await Bun.file(SESSION_MAP_FILE).text();
    const parsed = JSON.parse(content);
    
    // Validate structure
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as SessionMap;
    }
    
    console.warn("[session-map] Invalid session map structure, starting fresh");
    return {};
  } catch {
    // File doesn't exist or is malformed - return empty map
    return {};
  }
}

/**
 * Save the session map to disk atomically.
 * Uses Bun.write which is atomic for the write operation.
 */
async function saveMap(map: SessionMap): Promise<void> {
  await Bun.write(SESSION_MAP_FILE, JSON.stringify(map, null, 2) + "\n");
}

/**
 * Get a mapping entry for a channel+thread.
 * Returns null if no mapping exists.
 */
export async function get(
  channelId: string,
  threadId: string = DEFAULT_THREAD_ID
): Promise<SessionEntry | null> {
  await initSessionMap();
  
  if (!sessionMap) {
    return null;
  }
  
  return sessionMap[channelId]?.[threadId] ?? null;
}

/**
 * Set a mapping entry for a channel+thread.
 * Overwrites any existing entry.
 */
export async function set(
  channelId: string,
  threadId: string,
  entry: SessionEntry
): Promise<void> {
  await initSessionMap();
  
  await enqueueWrite(async () => {
    if (!sessionMap) {
      sessionMap = {};
    }
    
    if (!sessionMap[channelId]) {
      sessionMap[channelId] = {};
    }
    
    sessionMap[channelId][threadId] = entry;
    await saveMap(sessionMap);
  });
}

/**
 * Delete a mapping entry for a channel+thread.
 * Only removes the specific thread within the channel.
 */
export async function remove(
  channelId: string,
  threadId: string = DEFAULT_THREAD_ID
): Promise<void> {
  await initSessionMap();
  
  await enqueueWrite(async () => {
    if (!sessionMap || !sessionMap[channelId]) {
      return;
    }
    
    delete sessionMap[channelId][threadId];
    
    // Remove empty channel buckets
    if (Object.keys(sessionMap[channelId]).length === 0) {
      delete sessionMap[channelId];
    }
    
    await saveMap(sessionMap);
  });
}

/**
 * Update specific fields of a mapping entry.
 */
export async function update(
  channelId: string,
  threadId: string,
  patch: Partial<SessionEntry>
): Promise<void> {
  await initSessionMap();

  await enqueueWrite(async () => {
    const existing = sessionMap?.[channelId]?.[threadId] ?? null;
    if (!existing) {
      throw new Error(`No mapping found for channel=${channelId}, thread=${threadId}`);
    }

    const updated: SessionEntry = {
      ...existing,
      ...patch,
      mappingId: existing.mappingId, // Prevent overwriting identity
      updatedAt: new Date().toISOString(),
    };

    if (!sessionMap) sessionMap = {};
    if (!sessionMap[channelId]) sessionMap[channelId] = {};
    sessionMap[channelId][threadId] = updated;
    await saveMap(sessionMap);
  });
}

/**
 * Update the lastSeq for a channel+thread.
 */
export async function updateLastSeq(
  channelId: string,
  threadId: string,
  seq: number
): Promise<void> {
  await update(channelId, threadId, { lastSeq: seq });
}

/**
 * Increment the turn count for a channel+thread.
 */
export async function incrementTurnCount(
  channelId: string,
  threadId: string
): Promise<void> {
  await initSessionMap();

  await enqueueWrite(async () => {
    const existing = sessionMap?.[channelId]?.[threadId] ?? null;
    if (!existing) {
      throw new Error(`No mapping found for channel=${channelId}, thread=${threadId}`);
    }

    existing.turnCount += 1;
    existing.updatedAt = new Date().toISOString();
    await saveMap(sessionMap!);
  });
}

/**
 * Attach a real Claude session ID to a mapping.
 * Will not overwrite an existing non-null Claude session ID unless forced.
 */
export async function attachClaudeSessionId(
  channelId: string,
  threadId: string,
  claudeSessionId: string,
  force: boolean = false
): Promise<void> {
  await initSessionMap();

  await enqueueWrite(async () => {
    const existing = sessionMap?.[channelId]?.[threadId] ?? null;
    if (!existing) {
      throw new Error(`No mapping found for channel=${channelId}, thread=${threadId}`);
    }

    if (existing.claudeSessionId !== null && !force) {
      console.warn(
        `[session-map] Not overwriting existing claudeSessionId for channel=${channelId}, thread=${threadId}`
      );
      return;
    }

    existing.claudeSessionId = claudeSessionId;
    existing.status = "active";
    existing.updatedAt = new Date().toISOString();
    await saveMap(sessionMap!);
  });
}

/**
 * Get an existing mapping or create a new one.
 * New mappings start with claudeSessionId = null.
 */
export async function getOrCreateMapping(
  channelId: string,
  threadId: string = DEFAULT_THREAD_ID
): Promise<SessionEntry> {
  await initSessionMap();

  return enqueueWrite(async () => {
    const existing = sessionMap?.[channelId]?.[threadId] ?? null;

    if (existing) {
      // Update lastActiveAt inside the write lock
      existing.lastActiveAt = new Date().toISOString();
      existing.updatedAt = new Date().toISOString();
      if (!sessionMap) sessionMap = {};
      if (!sessionMap[channelId]) sessionMap[channelId] = {};
      sessionMap[channelId][threadId] = existing;
      await saveMap(sessionMap);
      return existing;
    }

    // Create new entry
    const now = new Date().toISOString();
    const newEntry: SessionEntry = {
      mappingId: randomUUID(),
      claudeSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      lastSeq: 0,
      turnCount: 0,
      status: "pending",
    };

    if (!sessionMap) sessionMap = {};
    if (!sessionMap[channelId]) sessionMap[channelId] = {};
    sessionMap[channelId][threadId] = newEntry;
    await saveMap(sessionMap);
    return newEntry;
  });
}

/**
 * List all channel IDs that have mappings.
 */
export async function listChannels(): Promise<string[]> {
  await initSessionMap();
  return Object.keys(sessionMap ?? {});
}

/**
 * List all thread IDs for a given channel.
 */
export async function listThreads(channelId: string): Promise<string[]> {
  await initSessionMap();
  return Object.keys(sessionMap?.[channelId] ?? {});
}

/**
 * Mark a mapping as stale.
 */
export async function markStale(
  channelId: string,
  threadId: string
): Promise<void> {
  await update(channelId, threadId, { status: "stale" });
}

/**
 * Conservative cleanup of old entries.
 * Removes entries that are:
 * - Explicitly reset
 * - Past TTL AND have no activity AND no Claude session attached
 * 
 * IMPORTANT: Does NOT auto-delete active mappings during ordinary get() calls.
 * Cleanup should be explicit or tightly controlled.
 */
export async function cleanup(maxAgeDays: number = DEFAULT_TTL_DAYS): Promise<number> {
  await initSessionMap();
  
  if (!sessionMap) {
    return 0;
  }
  
  let removedCount = 0;
  const now = new Date();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  
  await enqueueWrite(async () => {
    for (const channelId of Object.keys(sessionMap!)) {
      const channelEntries = sessionMap![channelId];
      const threadsToDelete: string[] = [];
      
      for (const threadId of Object.keys(channelEntries)) {
        const entry = channelEntries[threadId];
        
        // Check if entry is past TTL
        const lastActive = new Date(entry.lastActiveAt);
        const ageMs = now.getTime() - lastActive.getTime();
        
        // Cleanup candidates:
        // 1. Reset entries (explicitly marked for cleanup)
        // 2. Entries past TTL with no activity and no Claude session attached
        const isReset = entry.status === "reset";
        const isOldWithNoSession = ageMs > maxAgeMs && entry.claudeSessionId === null;
        const updatedAt = new Date(entry.updatedAt);
        const updateAgeMs = now.getTime() - updatedAt.getTime();
        const isOldWithNoRecentUpdate = updateAgeMs > maxAgeMs;
        
        if (isReset || (isOldWithNoSession && isOldWithNoRecentUpdate)) {
          threadsToDelete.push(threadId);
          removedCount++;
          console.debug(
            `[session-map] Cleanup removing: channel=${channelId}, thread=${threadId}, ` +
            `reason=${isReset ? "reset" : "old"}, age=${Math.round(ageMs / (24 * 60 * 60 * 1000))} days`
          );
        }
      }
      
      // Remove marked threads
      for (const threadId of threadsToDelete) {
        delete channelEntries[threadId];
      }
      
      // Remove empty channel buckets
      if (Object.keys(channelEntries).length === 0) {
        delete sessionMap![channelId];
      }
    }
    
    if (removedCount > 0) {
      await saveMap(sessionMap!);
      console.log(`[session-map] Cleanup removed ${removedCount} entries`);
    }
  });
  
  return removedCount;
}

// Re-export for convenience
export { DEFAULT_THREAD_ID, DEFAULT_TTL_DAYS };
