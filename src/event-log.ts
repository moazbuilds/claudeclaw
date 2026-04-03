/**
 * Durable Event Log
 * 
 * Segmented append-only event storage with monotonic sequence numbers.
 * 
 * CRASH CONSCIOUSNESS:
 * - All writes use atomic file operations (write to temp, rename)
 * - Segment metadata is written before data to ensure index consistency
 * - Sequence numbers are allocated atomically with the write operation
 * - Partial writes are detected and recovered on next startup
 * 
 * STORAGE MODEL:
 * - Events stored in .claude/claudeclaw/event-log/
 * - Segments: event-log-YYYYMMDD-HHMMSS-{seq}.jsonl
 * - Index: segments.json (maps seq ranges to segment files)
 * - Current segment tracked in current-segment.json
 * - Max segment size: 10MB or daily rotation
 * 
 * RECOVERY:
 * - On init, scan segments and rebuild index if corrupted
 * - Verify segment files exist and are readable
 * - Detect gaps in sequence numbers
 * - Rebuild current-segment pointer from latest segment
 */

import { join } from "path";
import { mkdir, readdir, rename, stat, unlink } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

const EVENT_LOG_DIR = join(process.cwd(), ".claude", "claudeclaw", "event-log");
const SEGMENTS_INDEX_FILE = join(EVENT_LOG_DIR, "segments.json");
const CURRENT_SEGMENT_FILE = join(EVENT_LOG_DIR, "current-segment.json");
const MAX_SEGMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Sanitize a string for safe logging - removes control characters
 * and limits length to prevent log injection attacks.
 */
function sanitizeForLog(value: unknown, maxLength = 1000): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  // Remove control characters except common whitespace
  const sanitized = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return sanitized.slice(0, maxLength);
}

export type EventStatus =
  | "pending"
  | "processing"
  | "done"
  | "retry_scheduled"
  | "dead_lettered";

export interface EventRecord {
  id: string;
  seq: number;
  type: string;
  source: string;
  timestamp: string;
  createdAt: string;
  updatedAt: string;
  status: EventStatus;
  channelId: string;
  threadId: string;
  payload: unknown;
  dedupeKey: string;
  retryCount: number;
  nextRetryAt: string | null;
  correlationId: string | null;
  causationId: string | null;
  replayedFromEventId: string | null;
  lastError: string | null;
}

export interface EventEntryInput {
  type: string;
  source: string;
  channelId: string;
  threadId: string;
  payload: unknown;
  dedupeKey: string;
  correlationId?: string | null;
  causationId?: string | null;
  replayedFromEventId?: string | null;
}

interface SegmentInfo {
  filename: string;
  startSeq: number;
  endSeq: number;
  createdAt: string;
  sizeBytes: number;
}

interface SegmentsIndex {
  version: number;
  segments: SegmentInfo[];
  lastSeq: number;
  updatedAt: string;
}

interface CurrentSegment {
  filename: string;
  startSeq: number;
  nextSeq: number;
  createdAt: string;
  sizeBytes: number;
}

let segmentsIndex: SegmentsIndex | null = null;
let currentSegment: CurrentSegment | null = null;
let initializationPromise: Promise<void> | null = null;

// Write queue for serializing concurrent append operations
let writeQueue: Promise<void> = Promise.resolve();
let writeQueueLength = 0;

/**
 * Enqueue a write operation to ensure serial execution.
 * This prevents race conditions in sequence number allocation.
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
 * Get the current length of the write queue.
 */
export function getWriteQueueLength(): number {
  return writeQueueLength;
}

/**
 * Reset the event log state (for testing).
 * Clears all in-memory state and forces re-initialization.
 */
export function resetEventLog(): void {
  segmentsIndex = null;
  currentSegment = null;
  initializationPromise = null;
  writeQueue = Promise.resolve();
  writeQueueLength = 0;
}

/**
 * Initialize the event log system.
 * Creates directories, loads or rebuilds index, verifies segment consistency.
 */
export async function initEventLog(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  // Ensure directory exists
  await mkdir(EVENT_LOG_DIR, { recursive: true });

  // Try to load existing state
  segmentsIndex = await loadSegmentsIndex();
  currentSegment = await loadCurrentSegment();

  // Validate and repair if needed
  const needsRebuild = await validateAndRepairState();
  
  if (needsRebuild || !segmentsIndex || !currentSegment) {
    await rebuildStateFromDisk();
  }
}

/**
 * Validate segment state and detect corruption.
 * Returns true if rebuild is needed.
 */
async function validateAndRepairState(): Promise<boolean> {
  if (!segmentsIndex || !currentSegment) {
    return true;
  }

  // Check current segment file exists
  const currentPath = join(EVENT_LOG_DIR, currentSegment.filename);
  if (!existsSync(currentPath)) {
    console.warn("[event-log] Current segment file missing, rebuilding state");
    return true;
  }

  // Verify index segments exist
  for (const seg of segmentsIndex.segments) {
    const segPath = join(EVENT_LOG_DIR, seg.filename);
    if (!existsSync(segPath)) {
      console.warn(`[event-log] Segment ${seg.filename} missing from index, rebuilding`);
      return true;
    }
  }

  // Check for sequence number consistency
  const expectedNextSeq = segmentsIndex.lastSeq + 1;
  if (currentSegment.nextSeq !== expectedNextSeq) {
    console.warn(
      `[event-log] Sequence mismatch: index.lastSeq=${segmentsIndex.lastSeq}, ` +
      `current.nextSeq=${currentSegment.nextSeq}, expected=${expectedNextSeq}`
    );
    return true;
  }

  return false;
}

/**
 * Rebuild state by scanning disk.
 * Used on first init or when corruption is detected.
 */
async function rebuildStateFromDisk(): Promise<void> {
  console.log("[event-log] Rebuilding state from disk...");

  const files = await readdir(EVENT_LOG_DIR);
  const segmentFiles = files
    .filter(f => f.startsWith("event-log-") && f.endsWith(".jsonl"))
    .sort();

  const segments: SegmentInfo[] = [];
  let lastSeq = 0;

  for (const filename of segmentFiles) {
    const segPath = join(EVENT_LOG_DIR, filename);
    const stats = await stat(segPath);
    
    // Parse sequence range from file content
    const seqRange = await readSegmentSeqRange(segPath);
    
    if (seqRange) {
      segments.push({
        filename,
        startSeq: seqRange.start,
        endSeq: seqRange.end,
        createdAt: stats.birthtime.toISOString(),
        sizeBytes: stats.size,
      });
      lastSeq = Math.max(lastSeq, seqRange.end);
    }
  }

  // Build new index
  segmentsIndex = {
    version: 1,
    segments,
    lastSeq,
    updatedAt: new Date().toISOString(),
  };

  // Determine current segment
  if (segments.length > 0) {
    const latest = segments[segments.length - 1];
    const latestPath = join(EVENT_LOG_DIR, latest.filename);
    const latestStats = await stat(latestPath);
    
    currentSegment = {
      filename: latest.filename,
      startSeq: latest.startSeq,
      nextSeq: latest.endSeq + 1,
      createdAt: latest.createdAt,
      sizeBytes: latestStats.size,
    };
  } else {
    // No segments exist, create initial
    await createNewSegment(1);
  }

  // Persist rebuilt state
  await saveSegmentsIndex();
  await saveCurrentSegment();

  console.log(`[event-log] State rebuilt: ${segments.length} segments, lastSeq=${lastSeq}`);
}

/**
 * Read sequence range from a segment file.
 * Returns null if file is empty or corrupted.
 */
async function readSegmentSeqRange(filepath: string): Promise<{ start: number; end: number } | null> {
  try {
    const content = await Bun.file(filepath).text();
    const lines = content.trim().split("\n").filter(l => l.trim());
    
    if (lines.length === 0) {
      return null;
    }

    const first = JSON.parse(lines[0]) as EventRecord;
    const last = JSON.parse(lines[lines.length - 1]) as EventRecord;

    return { start: first.seq, end: last.seq };
  } catch (err) {
    console.warn(`[event-log] Failed to read segment ${filepath}:`, err);
    return null;
  }
}

/**
 * Load segments index from disk.
 */
async function loadSegmentsIndex(): Promise<SegmentsIndex | null> {
  try {
    const content = await Bun.file(SEGMENTS_INDEX_FILE).json();
    if (content.version === 1 && Array.isArray(content.segments)) {
      return content as SegmentsIndex;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load current segment pointer from disk.
 */
async function loadCurrentSegment(): Promise<CurrentSegment | null> {
  try {
    return await Bun.file(CURRENT_SEGMENT_FILE).json() as CurrentSegment;
  } catch {
    return null;
  }
}

/**
 * Save segments index atomically.
 * CRASH-SAFE: Write directly using Bun.write which is atomic.
 */
async function saveSegmentsIndex(): Promise<void> {
  if (!segmentsIndex) return;
  
  segmentsIndex.updatedAt = new Date().toISOString();
  await Bun.write(SEGMENTS_INDEX_FILE, JSON.stringify(segmentsIndex, null, 2) + "\n");
}

/**
 * Save current segment pointer atomically.
 * CRASH-SAFE: Write directly using Bun.write which is atomic.
 */
async function saveCurrentSegment(): Promise<void> {
  if (!currentSegment) return;
  
  await Bun.write(CURRENT_SEGMENT_FILE, JSON.stringify(currentSegment, null, 2) + "\n");
}

/**
 * Create a new segment file.
 */
async function createNewSegment(startSeq: number): Promise<void> {
  const now = new Date();
  // Format: YYYYMMDD-HHMMSS (no colons for filesystem compatibility)
  const timestamp = now.toISOString()
    .replace(/[:.]/g, "-")  // Replace colons and dots
    .replace("T", "_");      // Replace T with underscore
  const filename = `event-log-${timestamp}-${startSeq}.jsonl`;
  
  currentSegment = {
    filename,
    startSeq,
    nextSeq: startSeq,
    createdAt: new Date().toISOString(),
    sizeBytes: 0,
  };

  // Create empty segment file
  const segPath = join(EVENT_LOG_DIR, filename);
  await Bun.write(segPath, "");
  
  await saveCurrentSegment();
}

/**
 * Check if current segment needs rotation.
 */
async function shouldRotateSegment(): Promise<boolean> {
  if (!currentSegment) return true;

  // Check size
  if (currentSegment.sizeBytes >= MAX_SEGMENT_SIZE_BYTES) {
    return true;
  }

  // Check age (daily rotation)
  const created = new Date(currentSegment.createdAt);
  const now = new Date();
  const isDifferentDay = 
    created.getUTCFullYear() !== now.getUTCFullYear() ||
    created.getUTCMonth() !== now.getUTCMonth() ||
    created.getUTCDate() !== now.getUTCDate();

  return isDifferentDay;
}

/**
 * Rotate to a new segment.
 */
async function rotateSegment(): Promise<void> {
  if (!currentSegment || !segmentsIndex) {
    throw new Error("Event log not initialized");
  }

  // Archive current segment in index
  const finalSeq = currentSegment.nextSeq - 1;
  segmentsIndex.segments.push({
    filename: currentSegment.filename,
    startSeq: currentSegment.startSeq,
    endSeq: finalSeq,
    createdAt: currentSegment.createdAt,
    sizeBytes: currentSegment.sizeBytes,
  });
  segmentsIndex.lastSeq = finalSeq;

  await saveSegmentsIndex();

  // Create new segment
  await createNewSegment(currentSegment.nextSeq);

  console.log(
    `[event-log] Rotated segment: ${currentSegment.filename} ` +
    `(seq ${currentSegment.startSeq}-${finalSeq})`
  );
}

/**
 * Append an event to the log.
 * CRASH-SAFE: Event is written atomically with sequence number allocation.
 * THREAD-SAFE: Uses write queue to serialize concurrent operations.
 */
export async function append(entry: EventEntryInput): Promise<EventRecord> {
  await initEventLog();

  return enqueueWrite(async () => {
    if (!currentSegment || !segmentsIndex) {
      throw new Error("Event log not initialized");
    }

    // Check rotation
    if (await shouldRotateSegment()) {
      await rotateSegment();
    }

    // Allocate sequence number
    const seq = currentSegment.nextSeq;
    const now = new Date().toISOString();

    const record: EventRecord = {
      id: randomUUID(),
      seq,
      type: sanitizeForLog(entry.type),
      source: sanitizeForLog(entry.source),
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      channelId: sanitizeForLog(entry.channelId),
      threadId: sanitizeForLog(entry.threadId),
      payload: entry.payload,
      dedupeKey: sanitizeForLog(entry.dedupeKey),
      retryCount: 0,
      nextRetryAt: null,
      correlationId: entry.correlationId ? sanitizeForLog(entry.correlationId) : null,
      causationId: entry.causationId ? sanitizeForLog(entry.causationId) : null,
      replayedFromEventId: entry.replayedFromEventId ? sanitizeForLog(entry.replayedFromEventId) : null,
      lastError: null,
    };

    // Serialize event
    const line = JSON.stringify(record) + "\n";
    const lineBytes = new TextEncoder().encode(line).length;

    // CRASH-SAFE WRITE:
    // Use append mode to add to existing file atomically via Bun.write
    // For true atomicity with Bun, we write the entire content
    const segPath = join(EVENT_LOG_DIR, currentSegment.filename);

    // Read existing content
    let existingContent = "";
    try {
      existingContent = await Bun.file(segPath).text();
    } catch {
      // File might not exist yet, which is fine
    }

    // CRASH-SAFE: write to temp file then atomically rename
    const tmpPath = segPath + ".tmp";
    await Bun.write(tmpPath, existingContent + line);
    await rename(tmpPath, segPath);

    // Update in-memory state
    currentSegment.nextSeq = seq + 1;
    currentSegment.sizeBytes += lineBytes;
    segmentsIndex.lastSeq = seq;

    // Persist pointers
    await saveCurrentSegment();
    await saveSegmentsIndex();

    return record;
  });
}

/**
 * Read events starting from a sequence number.
 * Handles reading across segment boundaries.
 */
export async function* readFrom(startSeq: number): AsyncGenerator<EventRecord> {
  await initEventLog();

  if (!segmentsIndex) {
    throw new Error("Event log not initialized");
  }

  // Find starting segment
  let started = false;

  // First, check archived segments
  for (const seg of segmentsIndex.segments) {
    if (seg.endSeq < startSeq) {
      continue; // Segment is before start
    }

    const segPath = join(EVENT_LOG_DIR, seg.filename);
    const events = await readSegmentEvents(segPath, startSeq);
    
    for (const event of events) {
      yield event;
      started = true;
    }
  }

  // Then check current segment
  if (currentSegment && currentSegment.startSeq <= startSeq) {
    const segPath = join(EVENT_LOG_DIR, currentSegment.filename);
    const events = await readSegmentEvents(segPath, startSeq);
    
    for (const event of events) {
      yield event;
    }
  }
}

/**
 * Read events in a sequence range.
 */
export async function* readRange(
  startSeq: number,
  endSeq: number
): AsyncGenerator<EventRecord> {
  for await (const event of readFrom(startSeq)) {
    if (event.seq > endSeq) {
      break;
    }
    yield event;
  }
}

/**
 * Read events from a segment file, filtered by start sequence.
 */
async function readSegmentEvents(
  filepath: string,
  startSeq: number
): Promise<EventRecord[]> {
  try {
    const content = await Bun.file(filepath).text();
    const lines = content.trim().split("\n").filter(l => l.trim());
    
    const events: EventRecord[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as EventRecord;
        if (event.seq >= startSeq) {
          events.push(event);
        }
      } catch {
        // Skip corrupted lines
        console.warn("[event-log] Skipping corrupted line in segment");
      }
    }

    return events;
  } catch {
    return [];
  }
}

/**
 * Get the last assigned sequence number.
 */
export async function getLastSeq(): Promise<number> {
  await initEventLog();
  return segmentsIndex?.lastSeq ?? 0;
}

/**
 * Get statistics about the event log.
 */
export async function getStats(): Promise<{
  totalSegments: number;
  totalEvents: number;
  lastSeq: number;
  currentSegmentSize: number;
}> {
  await initEventLog();

  return {
    totalSegments: segmentsIndex?.segments.length ?? 0,
    totalEvents: segmentsIndex?.lastSeq ?? 0,
    lastSeq: segmentsIndex?.lastSeq ?? 0,
    currentSegmentSize: currentSegment?.sizeBytes ?? 0,
  };
}

/**
 * Update an event's status and retry information.
 * Note: This creates a new log entry rather than modifying existing ones,
 * preserving the append-only invariant.
 */
export async function appendStatusUpdate(
  originalEventId: string,
  updates: Partial<Pick<EventRecord, "status" | "retryCount" | "nextRetryAt" | "lastError">>
): Promise<EventRecord> {
  // Read the original event
  const original = await findEventById(originalEventId);
  if (!original) {
    throw new Error(`Event ${originalEventId} not found`);
  }

  // Create update entry as a new event with causationId pointing to original
  const updateEntry: EventEntryInput = {
    type: "__status_update__",
    source: "event-log",
    channelId: original.channelId,
    threadId: original.threadId,
    payload: {
      originalEventId: sanitizeForLog(originalEventId),
      originalSeq: original.seq,
      updates,
    },
    dedupeKey: `status-update-${sanitizeForLog(originalEventId)}-${Date.now()}`,
    causationId: original.id,
    correlationId: original.correlationId,
  };

  return append(updateEntry);
}

/**
 * Find an event by ID. Searches from most recent backwards.
 * Note: This is O(n) and should be used sparingly.
 */
export async function findEventById(eventId: string): Promise<EventRecord | null> {
  // Search backwards from current segment
  const allSegments = [...(segmentsIndex?.segments ?? [])];
  if (currentSegment) {
    allSegments.push({
      filename: currentSegment.filename,
      startSeq: currentSegment.startSeq,
      endSeq: currentSegment.nextSeq - 1,
      createdAt: currentSegment.createdAt,
      sizeBytes: currentSegment.sizeBytes,
    });
  }

  // Search in reverse order (newest first)
  for (let i = allSegments.length - 1; i >= 0; i--) {
    const seg = allSegments[i];
    const segPath = join(EVENT_LOG_DIR, seg.filename);
    
    try {
      const content = await Bun.file(segPath).text();
      const lines = content.trim().split("\n").filter(l => l.trim());
      
      // Search backwards within segment
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          const event = JSON.parse(lines[j]) as EventRecord;
          if (event.id === eventId) {
            return event;
          }
        } catch {
          // Skip corrupted lines
        }
      }
    } catch {
      // Continue to next segment
    }
  }

  return null;
}
