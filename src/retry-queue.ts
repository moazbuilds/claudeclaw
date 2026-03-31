/**
 * Retry Scheduler
 * 
 * Manages retry scheduling for failed events with exponential backoff.
 * 
 * DESIGN:
 * - In-memory priority queue as rebuildable execution index
 * - Persisted event state remains the canonical source of truth
 * - Scheduler rebuilds itself from persisted state on restart
 * 
 * RETRY POLICY:
 * - Exponential backoff: delay = min(5s * 2^retryCount, 10min)
 * - Default maxRetries: 5 (configurable)
 * - Retry state stored in event records (nextRetryAt, retryCount)
 * 
 * PERSISTENCE:
 * - Retry state stored in retry-queue.json as auxiliary index
 * - Can be fully rebuilt from event log
 * - Not a competing source of truth
 */

import { join } from "path";
import { mkdir } from "fs/promises";
import {
  initEventLog,
  readFrom,
  appendStatusUpdate,
  type EventRecord,
  type EventStatus,
} from "./event-log";

const RETRY_DIR = join(process.cwd(), ".claude", "claudeclaw", "retry");
const RETRY_STATE_FILE = join(RETRY_DIR, "retry-queue.json");

const DEFAULT_BASE_DELAY_MS = 5000; // 5 seconds
const DEFAULT_MAX_DELAY_MS = 600000; // 10 minutes
const DEFAULT_MAX_RETRIES = 5;

interface RetryEntry {
  eventId: string;
  eventSeq: number;
  retryCount: number;
  nextRetryAt: string;
  scheduledAt: string;
}

interface RetryState {
  version: number;
  entries: RetryEntry[];
  lastProcessedAt: string;
  config: RetryConfig;
}

interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  checkIntervalMs: number;
}

// In-memory priority queue (rebuildable cache)
let retryQueue: RetryEntry[] = [];
let retryState: RetryState | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Initialize the retry scheduler.
 */
export async function initRetryScheduler(
  config: Partial<RetryConfig> = {}
): Promise<void> {
  await initEventLog();
  await mkdir(RETRY_DIR, { recursive: true });

  const fullConfig: RetryConfig = {
    baseDelayMs: config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    checkIntervalMs: config.checkIntervalMs ?? 5000,
  };

  // Load or create state
  retryState = await loadRetryState();
  if (!retryState) {
    retryState = {
      version: 1,
      entries: [],
      lastProcessedAt: new Date().toISOString(),
      config: fullConfig,
    };
  } else {
    // Update config if provided
    retryState.config = fullConfig;
  }

  // Rebuild in-memory queue from state
  await rebuildFromState();

  // Start background check loop
  startCheckLoop(fullConfig.checkIntervalMs);

  await saveRetryState();
}

/**
 * Load retry state from disk.
 */
async function loadRetryState(): Promise<RetryState | null> {
  try {
    const content = await Bun.file(RETRY_STATE_FILE).json();
    if (content.version === 1 && Array.isArray(content.entries)) {
      return content as RetryState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save retry state atomically.
 */
async function saveRetryState(): Promise<void> {
  if (!retryState) return;
  
  retryState.lastProcessedAt = new Date().toISOString();
  await Bun.write(RETRY_STATE_FILE, JSON.stringify(retryState, null, 2) + "\n");
}

/**
 * Calculate next retry delay using exponential backoff.
 */
function calculateRetryDelay(retryCount: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(2, retryCount);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Schedule an event for retry.
 */
export async function schedule(
  eventId: string,
  retryCount: number
): Promise<void> {
  if (!retryState) {
    throw new Error("Retry scheduler not initialized");
  }

  // Check if max retries exceeded
  if (retryCount >= retryState.config.maxRetries) {
    throw new Error(
      `Max retries (${retryState.config.maxRetries}) exceeded for event ${eventId}`
    );
  }

  // Find the event to get its sequence number
  let eventSeq = 0;
  for await (const event of readFrom(1)) {
    if (event.id === eventId) {
      eventSeq = event.seq;
      break;
    }
  }

  if (eventSeq === 0) {
    throw new Error(`Event ${eventId} not found`);
  }

  // Calculate next retry time
  const delay = calculateRetryDelay(retryCount, retryState.config);
  const nextRetryAt = new Date(Date.now() + delay).toISOString();

  const entry: RetryEntry = {
    eventId,
    eventSeq,
    retryCount,
    nextRetryAt,
    scheduledAt: new Date().toISOString(),
  };

  // Add to in-memory queue (sorted by nextRetryAt)
  const insertIndex = retryQueue.findIndex(
    e => e.nextRetryAt > nextRetryAt
  );
  if (insertIndex === -1) {
    retryQueue.push(entry);
  } else {
    retryQueue.splice(insertIndex, 0, entry);
  }

  // Update persisted state
  // Remove existing entry if present
  retryState.entries = retryState.entries.filter(e => e.eventId !== eventId);
  retryState.entries.push(entry);
  
  await saveRetryState();

  console.log(
    `[retry] Scheduled event ${eventId} for retry ${retryCount + 1} ` +
    `at ${nextRetryAt} (delay: ${delay}ms)`
  );
}

/**
 * Get the next due retry entry without removing it.
 */
export function peekDue(): RetryEntry | null {
  const now = new Date().toISOString();
  
  for (const entry of retryQueue) {
    if (entry.nextRetryAt <= now) {
      return entry;
    }
  }
  
  return null;
}

/**
 * Pop and return the next due retry entry.
 */
export function popDue(): RetryEntry | null {
  const now = new Date().toISOString();
  
  for (let i = 0; i < retryQueue.length; i++) {
    if (retryQueue[i].nextRetryAt <= now) {
      const entry = retryQueue.splice(i, 1)[0];
      
      // Also remove from persisted state
      if (retryState) {
        retryState.entries = retryState.entries.filter(
          e => e.eventId !== entry.eventId
        );
      }
      
      return entry;
    }
  }
  
  return null;
}

/**
 * Remove an event from the retry queue.
 */
export async function remove(eventId: string): Promise<void> {
  // Remove from in-memory queue
  retryQueue = retryQueue.filter(e => e.eventId !== eventId);
  
  // Remove from persisted state
  if (retryState) {
    retryState.entries = retryState.entries.filter(e => e.eventId !== eventId);
    await saveRetryState();
  }
}

/**
 * Rebuild the in-memory queue from persisted state.
 * Called on startup to reconstruct the queue.
 */
export async function rebuildFromState(): Promise<void> {
  if (!retryState) {
    retryQueue = [];
    return;
  }

  // Sort by nextRetryAt
  retryQueue = [...retryState.entries].sort(
    (a, b) => new Date(a.nextRetryAt).getTime() - new Date(b.nextRetryAt).getTime()
  );

  console.log(`[retry] Rebuilt queue with ${retryQueue.length} entries`);
}

/**
 * Rebuild the persisted state from the event log.
 * Scans for events with retry_scheduled status.
 */
export async function rebuildFromEventLog(): Promise<number> {
  if (!retryState) {
    throw new Error("Retry scheduler not initialized");
  }

  const newEntries: RetryEntry[] = [];

  for await (const event of readFrom(1)) {
    // Handle __status_update__ events which have status in payload.updates
    if (event.type === "__status_update__") {
      const payload = event.payload as {
        originalEventId?: string;
        originalSeq?: number;
        updates?: {
          status?: string;
          retryCount?: number;
          nextRetryAt?: string;
        };
      };
      const updates = payload?.updates;
      if (
        updates?.status === "retry_scheduled" &&
        updates?.nextRetryAt &&
        updates?.retryCount !== undefined &&
        updates.retryCount < retryState.config.maxRetries
      ) {
        newEntries.push({
          eventId: payload.originalEventId || "",
          eventSeq: payload.originalSeq || 0,
          retryCount: updates.retryCount,
          nextRetryAt: updates.nextRetryAt,
          scheduledAt: event.updatedAt,
        });
      }
      continue;
    }

    // Regular events with retry_scheduled status
    if (
      event.status === "retry_scheduled" &&
      event.nextRetryAt &&
      event.retryCount < retryState.config.maxRetries
    ) {
      newEntries.push({
        eventId: event.id,
        eventSeq: event.seq,
        retryCount: event.retryCount,
        nextRetryAt: event.nextRetryAt,
        scheduledAt: event.updatedAt,
      });
    }
  }

  retryState.entries = newEntries;
  await rebuildFromState();
  await saveRetryState();

  console.log(`[retry] Rebuilt from event log: ${newEntries.length} entries`);
  return newEntries.length;
}

/**
 * Process due retries.
 * This is called by the check loop.
 */
async function processDueRetries(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    let processed = 0;
    let entry: RetryEntry | null;

    while ((entry = popDue()) !== null) {
      processed++;
      
      // Update event status to pending for reprocessing
      await appendStatusUpdate(entry.eventId, {
        status: "pending",
        retryCount: entry.retryCount + 1,
        nextRetryAt: null,
      });

      console.log(
        `[retry] Event ${entry.eventId} ready for retry ${entry.retryCount + 1}`
      );
    }

    if (processed > 0) {
      await saveRetryState();
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the background check loop.
 */
function startCheckLoop(intervalMs: number): void {
  if (checkInterval) {
    clearInterval(checkInterval);
  }

  checkInterval = setInterval(() => {
    processDueRetries().catch(err => {
      console.error("[retry] Error processing due retries:", err);
    });
  }, intervalMs);

  console.log(`[retry] Started check loop (interval: ${intervalMs}ms)`);
}

/**
 * Stop the background check loop.
 */
export function stopCheckLoop(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log("[retry] Stopped check loop");
  }
}

/**
 * Get the number of pending retries.
 */
export function getPendingRetryCount(): number {
  return retryQueue.length;
}

/**
 * Get the next retry time (null if queue is empty).
 */
export function getNextRetryTime(): string | null {
  if (retryQueue.length === 0) return null;
  return retryQueue[0].nextRetryAt;
}

/**
 * Get retry statistics.
 */
export function getRetryStats(): {
  pendingCount: number;
  nextRetryAt: string | null;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
} {
  return {
    pendingCount: retryQueue.length,
    nextRetryAt: getNextRetryTime(),
    maxRetries: retryState?.config.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: retryState?.config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: retryState?.config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };
}

/**
 * Reset the retry scheduler (for testing).
 */
export async function resetRetryScheduler(): Promise<void> {
  stopCheckLoop();
  retryQueue = [];
  retryState = null;
  isProcessing = false;
}

/**
 * Check if an event is scheduled for retry.
 */
export function isScheduled(eventId: string): boolean {
  return retryQueue.some(e => e.eventId === eventId);
}
