/**
 * Resume Logic Module
 * 
 * Bridges normalized inbound events, session mappings, and real Claude CLI session resumption.
 * Enables deterministic session resumption per conversation thread using the ACTUAL
 * Claude session ID once one has been created by the runner.
 * 
 * CRITICAL DESIGN CONSTRAINTS:
 * - Do NOT generate random UUIDs and treat them as Claude session IDs
 * - local mapping identity may be generated locally
 * - Claude session identity must come from runner / Claude output
 * - `--resume` must only be emitted when a real `claudeSessionId` exists
 */

import { 
  get, 
  set, 
  remove,
  getOrCreateMapping as sessionMapGetOrCreate,
  attachClaudeSessionId as sessionMapAttachClaudeSessionId,
  update as sessionMapUpdate,
  type SessionEntry,
  type SessionStatus
} from "./session-map";
import type { NormalizedEvent } from "./normalizer";

// --- Core types ---

export interface ResumeArgs {
  mappingId: string;
  claudeSessionId: string | null;
  args: string[];
  isNewMapping: boolean;
  canResume: boolean;
}

export interface UpdateSessionOptions {
  turnCountIncrement?: number;
  status?: SessionStatus;
}

export interface SessionStats {
  mappingId: string;
  claudeSessionId: string | null;
  lastSeq: number;
  turnCount: number;
  status: SessionStatus;
  lastActiveAt: string;
  createdAt: string;
  isStale: boolean;
  canResume: boolean;
}

// Default threshold for stale detection (24 hours in ms)
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Threshold for compact warning (1 hour in ms)
const COMPACT_WARNING_THRESHOLD_MS = 60 * 60 * 1000;

// --- Task 1: Core lookup and resume argument logic ---

/**
 * Get an existing session mapping or create a new one.
 * New mappings start with claudeSessionId = null (waiting for real session ID from runner).
 * 
 * @param channelId - The channel identifier (e.g., "telegram:123")
 * @param threadId - The thread/conversation identifier (defaults to "default")
 * @returns The session entry (existing or newly created)
 */
export async function getOrCreateSessionMapping(
  channelId: string,
  threadId: string = "default"
): Promise<SessionEntry> {
  return sessionMapGetOrCreate(channelId, threadId);
}

/**
 * Get resume arguments for a channel+thread combination.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier (defaults to "default")
 * @returns ResumeArgs object containing:
 *   - mappingId: The session mapping identifier
 *   - claudeSessionId: Real Claude session ID or null
 *   - args: CLI arguments (--resume with session ID if canResume)
 *   - isNewMapping: Whether this was a newly created mapping
 *   - canResume: Whether this session can be resumed (has real Claude session ID)
 */
export async function getResumeArgs(
  channelId: string,
  threadId: string = "default"
): Promise<ResumeArgs> {
  const entry = await get(channelId, threadId);
  
  if (!entry) {
    // No mapping exists - create one
    const newEntry = await getOrCreateSessionMapping(channelId, threadId);
    return {
      mappingId: newEntry.mappingId,
      claudeSessionId: null,
      args: [],
      isNewMapping: true,
      canResume: false,
    };
  }
  
  const canResume = entry.claudeSessionId !== null;
  
  return {
    mappingId: entry.mappingId,
    claudeSessionId: entry.claudeSessionId,
    args: canResume ? ["--resume", entry.claudeSessionId] : [],
    isNewMapping: false,
    canResume,
  };
}

/**
 * Get resume arguments from a normalized event.
 * Convenience wrapper around getResumeArgs using event's channelId and threadId.
 * 
 * @param event - A NormalizedEvent
 * @returns ResumeArgs for the event's channel+thread
 */
export async function getResumeArgsForEvent(event: NormalizedEvent): Promise<ResumeArgs> {
  return getResumeArgs(event.channelId, event.threadId);
}

// --- Task 2: Post-processing metadata updates ---

/**
 * Record the real Claude session ID after first successful runner execution.
 * This should be called once the runner returns the actual Claude session ID.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier
 * @param claudeSessionId - The real Claude session ID from the runner
 */
export async function recordClaudeSessionId(
  channelId: string,
  threadId: string,
  claudeSessionId: string
): Promise<void> {
  // Only attach if we have a real session ID (not null/empty)
  if (!claudeSessionId || claudeSessionId.trim() === "") {
    console.warn(
      `[resume] Not recording empty claudeSessionId for channel=${channelId}, thread=${threadId}`
    );
    return;
  }
  
  await sessionMapAttachClaudeSessionId(channelId, threadId, claudeSessionId);
}

/**
 * Update session metadata after successful processing.
 * Updates lastSeq, turnCount, lastActiveAt, and optionally status.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier
 * @param seq - The sequence number to record
 * @param options - Optional updates (turnCountIncrement, status)
 */
export async function updateSessionAfterProcessing(
  channelId: string,
  threadId: string,
  seq: number,
  options?: UpdateSessionOptions
): Promise<void> {
  const existing = await get(channelId, threadId);
  if (!existing) {
    console.warn(
      `[resume] No mapping found for channel=${channelId}, thread=${threadId} during updateSessionAfterProcessing`
    );
    return;
  }
  
  const now = new Date().toISOString();
  const patch: Partial<SessionEntry> = {
    lastSeq: seq,
    lastActiveAt: now,
    updatedAt: now,
  };
  
  // Handle turn count increment
  if (options?.turnCountIncrement !== undefined) {
    patch.turnCount = existing.turnCount + options.turnCountIncrement;
  } else {
    // Default: increment by 1 for each processing
    patch.turnCount = existing.turnCount + 1;
  }
  
  // Handle status update
  if (options?.status) {
    patch.status = options.status;
  } else if (existing.status === "pending") {
    // Upgrade pending to active on first successful processing
    patch.status = "active";
  }
  
  await sessionMapUpdate(channelId, threadId, patch);
}

/**
 * Get statistics for a session mapping.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier
 * @returns SessionStats or null if no mapping exists
 */
export async function getSessionStats(
  channelId: string,
  threadId: string
): Promise<SessionStats | null> {
  const entry = await get(channelId, threadId);
  
  if (!entry) {
    return null;
  }
  
  const now = new Date().getTime();
  const lastActive = new Date(entry.lastActiveAt).getTime();
  const isStale = (now - lastActive) > DEFAULT_STALE_THRESHOLD_MS;
  
  return {
    mappingId: entry.mappingId,
    claudeSessionId: entry.claudeSessionId,
    lastSeq: entry.lastSeq,
    turnCount: entry.turnCount,
    status: entry.status,
    lastActiveAt: entry.lastActiveAt,
    createdAt: entry.createdAt,
    isStale,
    canResume: entry.claudeSessionId !== null,
  };
}

// --- Task 3: Lifecycle helpers ---

/**
 * Reset a session mapping.
 * Marks it as reset and removes it from storage.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier
 */
export async function resetSession(
  channelId: string,
  threadId: string
): Promise<void> {
  const existing = await get(channelId, threadId);
  if (!existing) {
    console.debug(
      `[resume] No mapping found to reset for channel=${channelId}, thread=${threadId}`
    );
    return;
  }
  
  // Mark as reset first (helps with cleanup tracking)
  await sessionMapUpdate(channelId, threadId, { status: "reset" });
  
  // Then remove the entry
  await remove(channelId, threadId);
}

/**
 * Check if a session is stale based on lastActiveAt.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier
 * @param thresholdMs - Stale threshold in milliseconds (defaults to 24 hours)
 * @returns true if the session is stale, false otherwise
 */
export async function isSessionStale(
  channelId: string,
  threadId: string,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS
): Promise<boolean> {
  const entry = await get(channelId, threadId);
  
  if (!entry) {
    return true; // No mapping = considered stale
  }
  
  const now = new Date().getTime();
  const lastActive = new Date(entry.lastActiveAt).getTime();
  
  return (now - lastActive) > thresholdMs;
}

/**
 * Check if a session should trigger a compaction warning.
 * Sessions that have been active for an extended period may benefit from compaction.
 * 
 * @param channelId - The channel identifier
 * @param threadId - The thread/conversation identifier
 * @returns true if compaction warning should be shown
 */
export async function shouldWarnCompact(
  channelId: string,
  threadId: string
): Promise<boolean> {
  const entry = await get(channelId, threadId);
  
  if (!entry) {
    return false;
  }
  
  const now = new Date().getTime();
  const lastActive = new Date(entry.lastActiveAt).getTime();
  
  // Warn if session has been continuously active for > 1 hour
  // and has accumulated significant turn count
  return (
    (now - lastActive) < COMPACT_WARNING_THRESHOLD_MS &&
    entry.turnCount > 50
  );
}

// Re-export constants for external use
export { DEFAULT_STALE_THRESHOLD_MS, COMPACT_WARNING_THRESHOLD_MS };
