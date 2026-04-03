/**
 * Dead Letter Queue (DLQ)
 * 
 * Captures permanently failed events with full failure provenance.
 * 
 * DESIGN:
 * - DLQ entries stored in .claude/claudeclaw/dlq.jsonl
 * - Each entry contains full event + retry history + final error
 * - Supports replay back to the event log for reprocessing
 * - CLI commands: dlq list, dlq replay <id>
 * 
 * ENTRY SCHEMA:
 * {
 *   id,                    // DLQ entry ID (unique)
 *   originalEventId,       // Reference to original event
 *   originalSeq,
 *   event,                 // Full event record snapshot
 *   retryHistory,          // Array of retry attempts
 *   firstFailureAt,        // When processing first failed
 *   lastFailureAt,         // When moved to DLQ
 *   finalError,            // Last error message
 *   errorType,             // Error classification if available
 *   deadLetteredAt,        // When moved to DLQ
 *   replayCount,           // How many times replayed
 *   replayHistory          // Array of replay attempts
 * }
 */

import { join } from "path";
import { mkdir, appendFile } from "fs/promises";
import { randomUUID } from "crypto";
import {
  initEventLog,
  append,
  readFrom,
  type EventRecord,
} from "./event-log";

const DLQ_DIR = join(process.cwd(), ".claude", "claudeclaw", "dlq");
const DLQ_FILE = join(DLQ_DIR, "dlq.jsonl");

interface RetryAttempt {
  attempt: number;
  error: string;
  timestamp: string;
}

interface ReplayAttempt {
  replayedAt: string;
  newEventId: string;
  newSeq: number;
}

export interface DLQEntry {
  id: string;
  originalEventId: string;
  originalSeq: number;
  event: EventRecord;
  retryHistory: RetryAttempt[];
  firstFailureAt: string;
  lastFailureAt: string;
  finalError: string;
  errorType: string | null;
  deadLetteredAt: string;
  replayCount: number;
  replayHistory: ReplayAttempt[];
}

let dlqEntries: DLQEntry[] = [];
let isInitialized = false;

/**
 * Initialize the DLQ.
 */
export async function initDLQ(): Promise<void> {
  if (isInitialized) return;
  
  await initEventLog();
  await mkdir(DLQ_DIR, { recursive: true });
  
  // Load existing DLQ entries
  await loadDLQ();
  
  isInitialized = true;
}

/**
 * Load DLQ entries from disk.
 */
async function loadDLQ(): Promise<void> {
  dlqEntries = [];
  
  try {
    const content = await Bun.file(DLQ_FILE).text();
    const lines = content.trim().split("\n").filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as DLQEntry;
        dlqEntries.push(entry);
      } catch {
        // Skip corrupted lines
      }
    }
  } catch {
    // File doesn't exist yet, that's fine
  }
}

/**
 * Save a DLQ entry to disk.
 */
async function saveDLQEntry(entry: DLQEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";

  try {
    // Use appendFile for O(1) additions instead of read-whole-file + write-whole-file
    await appendFile(DLQ_FILE, line);
  } catch (err) {
    console.error("[dlq] Failed to save DLQ entry:", err);
    throw err;
  }
}

/**
 * Move an event to the DLQ.
 * Called when max retries are exceeded.
 */
export async function enqueue(
  event: EventRecord,
  retryHistory: RetryAttempt[],
  finalError: string,
  errorType?: string
): Promise<DLQEntry> {
  await initDLQ();

  const entry: DLQEntry = {
    id: randomUUID(),
    originalEventId: event.id,
    originalSeq: event.seq,
    event: { ...event }, // Snapshot of event at time of failure
    retryHistory: [...retryHistory],
    firstFailureAt: retryHistory[0]?.timestamp ?? new Date().toISOString(),
    lastFailureAt: new Date().toISOString(),
    finalError,
    errorType: errorType ?? null,
    deadLetteredAt: new Date().toISOString(),
    replayCount: 0,
    replayHistory: [],
  };

  // Add to in-memory array
  dlqEntries.push(entry);
  
  // Persist to disk
  await saveDLQEntry(entry);

  console.log(
    `[dlq] Event ${event.id} (seq ${event.seq}) moved to DLQ: ${finalError}`
  );

  return entry;
}

/**
 * List all DLQ entries, most recent first.
 */
export function list(): DLQEntry[] {
  return [...dlqEntries].reverse();
}

/**
 * List DLQ entries with pagination.
 */
export function listPaginated(
  page: number = 1,
  pageSize: number = 20
): { entries: DLQEntry[]; total: number; page: number; totalPages: number } {
  const total = dlqEntries.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  
  return {
    entries: [...dlqEntries].reverse().slice(start, end),
    total,
    page,
    totalPages,
  };
}

/**
 * Find a DLQ entry by ID.
 */
export function findById(id: string): DLQEntry | null {
  return dlqEntries.find(e => e.id === id) ?? null;
}

/**
 * Find a DLQ entry by original event ID.
 */
export function findByEventId(eventId: string): DLQEntry | null {
  return dlqEntries.find(e => e.originalEventId === eventId) ?? null;
}

/**
 * Replay a DLQ entry back to the event log.
 * Creates a new event with replay provenance.
 */
export async function replay(dlqEntryId: string): Promise<EventRecord | null> {
  await initDLQ();
  
  const entry = findById(dlqEntryId);
  if (!entry) {
    throw new Error(`DLQ entry ${dlqEntryId} not found`);
  }

  // Create new event from DLQ entry
  const { append } = await import("./event-log");
  
  const newEvent = await append({
    type: entry.event.type,
    source: entry.event.source,
    channelId: entry.event.channelId,
    threadId: entry.event.threadId,
    payload: entry.event.payload,
    dedupeKey: entry.event.dedupeKey,
    correlationId: entry.event.correlationId,
    causationId: entry.event.id, // Original event is the causation
    replayedFromEventId: entry.event.id,
  });

  // Update DLQ entry with replay history
  entry.replayCount++;
  entry.replayHistory.push({
    replayedAt: new Date().toISOString(),
    newEventId: newEvent.id,
    newSeq: newEvent.seq,
  });

  // Update the entry in the file (rewrite entire file - DLQ should be small)
  await rewriteDLQFile();

  console.log(
    `[dlq] Replayed event ${entry.originalEventId} as ${newEvent.id} (seq ${newEvent.seq})`
  );

  return newEvent;
}

/**
 * Replay all DLQ entries.
 * Returns count of replayed events.
 */
export async function replayAll(): Promise<number> {
  await initDLQ();
  
  let count = 0;
  for (const entry of dlqEntries) {
    try {
      await replay(entry.id);
      count++;
    } catch (err) {
      console.error(`[dlq] Failed to replay ${entry.id}:`, err);
    }
  }

  return count;
}

/**
 * Remove an entry from the DLQ.
 * Useful for manual cleanup after investigation.
 */
export async function remove(dlqEntryId: string): Promise<void> {
  await initDLQ();
  
  const index = dlqEntries.findIndex(e => e.id === dlqEntryId);
  if (index === -1) {
    throw new Error(`DLQ entry ${dlqEntryId} not found`);
  }

  dlqEntries.splice(index, 1);
  await rewriteDLQFile();

  console.log(`[dlq] Removed entry ${dlqEntryId}`);
}

/**
 * Rewrite the entire DLQ file.
 * Used after updates that modify entries.
 */
async function rewriteDLQFile(): Promise<void> {
  const lines = dlqEntries.map(e => JSON.stringify(e)).join("\n") + "\n";
  await Bun.write(DLQ_FILE, lines);
}

/**
 * Get DLQ statistics.
 */
export function getStats(): {
  totalEntries: number;
  totalReplays: number;
  oldestEntry: string | null;
  newestEntry: string | null;
} {
  if (dlqEntries.length === 0) {
    return {
      totalEntries: 0,
      totalReplays: 0,
      oldestEntry: null,
      newestEntry: null,
    };
  }

  const sorted = [...dlqEntries].sort(
    (a, b) => new Date(a.deadLetteredAt).getTime() - new Date(b.deadLetteredAt).getTime()
  );

  const totalReplays = dlqEntries.reduce((sum, e) => sum + e.replayCount, 0);

  return {
    totalEntries: dlqEntries.length,
    totalReplays,
    oldestEntry: sorted[0].deadLetteredAt,
    newestEntry: sorted[sorted.length - 1].deadLetteredAt,
  };
}

/**
 * Clear all DLQ entries (use with caution).
 */
export async function clear(): Promise<void> {
  await initDLQ();
  
  dlqEntries = [];
  await Bun.write(DLQ_FILE, "");
  
  console.log("[dlq] Cleared all entries");
}

/**
 * Reset DLQ state (for testing).
 */
export async function resetDLQ(): Promise<void> {
  dlqEntries = [];
  isInitialized = false;
}

/**
 * Scan the event log for dead_lettered events and sync to DLQ.
 * Useful for rebuilding DLQ state from event log.
 */
export async function syncFromEventLog(): Promise<number> {
  await initDLQ();
  await initEventLog();

  let added = 0;

  for await (const event of readFrom(1)) {
    if (event.status === "dead_lettered") {
      // Check if already in DLQ
      const exists = findByEventId(event.id);
      if (!exists) {
        // Create synthetic DLQ entry
        const entry: DLQEntry = {
          id: randomUUID(),
          originalEventId: event.id,
          originalSeq: event.seq,
          event: { ...event },
          retryHistory: [],
          firstFailureAt: event.updatedAt,
          lastFailureAt: event.updatedAt,
          finalError: event.lastError ?? "Unknown error",
          errorType: null,
          deadLetteredAt: event.updatedAt,
          replayCount: 0,
          replayHistory: [],
        };

        dlqEntries.push(entry);
        await saveDLQEntry(entry);
        added++;
      }
    }
  }

  console.log(`[dlq] Synced ${added} entries from event log`);
  return added;
}
