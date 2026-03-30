/**
 * Idempotent Event Processor
 * 
 * Processes events from the durable event log with deduplication support.
 * 
 * DEDUPLICATION STRATEGY:
 * - Uses dedupeKey from event record (prefer upstream event IDs when available)
 * - Falls back to canonical key: hash(source + type + channelId + threadId + normalizedPayload)
 * - Persists dedupe state to disk with retention policy
 * - Dedupe state is replay-safe and survives restarts
 * 
 * RETENTION:
 * - Default retention: 7 days
 * - Configurable via config
 * - Cleanup runs periodically
 * 
 * PROCESSING:
 * - Phase 1: Serial processing for correctness
 * - Design supports future partitioned concurrency
 * - Events processed in sequence order
 */

import { join } from "path";
import { mkdir } from "fs/promises";
import { createHash } from "crypto";
import {
  initEventLog,
  readFrom,
  appendStatusUpdate,
  getLastSeq,
  type EventRecord,
  type EventStatus,
} from "./event-log";
import { list as listDLQ } from "./dead-letter-queue";
import { handleDlqOverflow } from "./escalation";

const DEDUPE_DIR = join(process.cwd(), ".claude", "claudeclaw", "dedupe");
const DEDUPE_STATE_FILE = join(DEDUPE_DIR, "state.json");
const DEFAULT_RETENTION_DAYS = 7;

interface DedupeEntry {
  key: string;
  eventId: string;
  eventSeq: number;
  timestamp: string;
  processedAt: string;
}

interface DedupeState {
  version: number;
  entries: DedupeEntry[];
  lastCleanupAt: string;
}

interface ProcessorConfig {
  retentionDays: number;
  onEvent: (event: EventRecord) => Promise<ProcessingResult>;
}

export interface ProcessingResult {
  success: boolean;
  error?: string;
  shouldRetry?: boolean;
}

let dedupeState: DedupeState | null = null;
let processorConfig: ProcessorConfig | null = null;
let isProcessing = false;
let lastProcessedSeq = 0;

/**
 * Initialize the event processor.
 * Loads or creates dedupe state.
 */
export async function initProcessor(config: ProcessorConfig): Promise<void> {
  await initEventLog();
  await mkdir(DEDUPE_DIR, { recursive: true });

  processorConfig = config;
  lastProcessedSeq = 0; // Always start fresh

  // Load or create dedupe state
  dedupeState = await loadDedupeState();
  if (!dedupeState) {
    dedupeState = {
      version: 1,
      entries: [],
      lastCleanupAt: new Date().toISOString(),
    };
    await saveDedupeState();
  }

  // Run cleanup if needed
  await maybeCleanup();
}

/**
 * Load dedupe state from disk.
 */
async function loadDedupeState(): Promise<DedupeState | null> {
  try {
    const content = await Bun.file(DEDUPE_STATE_FILE).json();
    if (content.version === 1 && Array.isArray(content.entries)) {
      return content as DedupeState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save dedupe state atomically.
 */
async function saveDedupeState(): Promise<void> {
  if (!dedupeState) return;
  await Bun.write(DEDUPE_STATE_FILE, JSON.stringify(dedupeState, null, 2) + "\n");
}

/**
 * Generate a canonical dedupe key for an event.
 * Used when upstream doesn't provide a dedupeKey.
 */
function generateDedupeKey(event: EventRecord): string {
  // Normalize payload for consistent hashing
  const normalizedPayload = JSON.stringify(event.payload, Object.keys(event.payload || {}).sort());
  
  const keyData = `${event.source}:${event.type}:${event.channelId}:${event.threadId}:${normalizedPayload}`;
  return createHash("sha256").update(keyData).digest("hex");
}

/**
 * Get the effective dedupe key for an event.
 * Prefers upstream dedupeKey, falls back to canonical key.
 */
function getDedupeKey(event: EventRecord): string {
  // If upstream provided a dedupeKey, use it
  if (event.dedupeKey && event.dedupeKey.length > 0) {
    return event.dedupeKey;
  }
  
  // Otherwise generate canonical key
  return generateDedupeKey(event);
}

/**
 * Check if an event is a duplicate.
 */
function isDuplicate(key: string): boolean {
  if (!dedupeState) return false;
  return dedupeState.entries.some(e => e.key === key);
}

/**
 * Record an event as processed for deduplication.
 */
async function recordProcessed(event: EventRecord, key: string): Promise<void> {
  if (!dedupeState) return;

  const entry: DedupeEntry = {
    key,
    eventId: event.id,
    eventSeq: event.seq,
    timestamp: event.timestamp,
    processedAt: new Date().toISOString(),
  };

  dedupeState.entries.push(entry);
  await saveDedupeState();
}

/**
 * Clean up old dedupe entries based on retention policy.
 */
async function cleanupOldEntries(): Promise<void> {
  if (!dedupeState || !processorConfig) return;

  const retentionDays = processorConfig.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const beforeCount = dedupeState.entries.length;
  dedupeState.entries = dedupeState.entries.filter(e => e.timestamp >= cutoffISO);
  dedupeState.lastCleanupAt = new Date().toISOString();

  const removedCount = beforeCount - dedupeState.entries.length;
  if (removedCount > 0) {
    console.log(`[processor] Cleaned up ${removedCount} old dedupe entries`);
    await saveDedupeState();
  }
}

/**
 * Run cleanup if it's been a while since the last one.
 */
async function maybeCleanup(): Promise<void> {
  if (!dedupeState) return;

  const lastCleanup = new Date(dedupeState.lastCleanupAt);
  const now = new Date();
  const hoursSinceCleanup = (now.getTime() - lastCleanup.getTime()) / (1000 * 60 * 60);

  // Cleanup daily
  if (hoursSinceCleanup >= 24) {
    await cleanupOldEntries();
  }
}

/**
 * Process the next pending event.
 * Returns true if an event was processed, false if no pending events.
 */
export async function processNext(): Promise<boolean> {
  if (!processorConfig) {
    throw new Error("Processor not initialized. Call initProcessor() first.");
  }

  if (isProcessing) {
    return false; // Already processing
  }

  isProcessing = true;

  try {
    // Find next pending event
    let nextEvent: EventRecord | null = null;
    
    for await (const event of readFrom(lastProcessedSeq + 1)) {
      // Skip non-pending events and internal events (like status updates)
      if (event.status === "pending" && !event.type.startsWith("__")) {
        nextEvent = event;
        break;
      }
      lastProcessedSeq = Math.max(lastProcessedSeq, event.seq);
    }

    if (!nextEvent) {
      return false; // No pending events
    }

    // Check for duplicates
    const dedupeKey = getDedupeKey(nextEvent);
    if (isDuplicate(dedupeKey)) {
      console.log(`[processor] Skipping duplicate event ${nextEvent.id} (seq ${nextEvent.seq})`);
      
      // Mark as done without processing
      await appendStatusUpdate(nextEvent.id, {
        status: "done",
      });
      
      lastProcessedSeq = nextEvent.seq;
      return true;
    }

    // Process the event
    console.log(`[processor] Processing event ${nextEvent.id} (seq ${nextEvent.seq}, type: ${nextEvent.type})`);
    
    let result: ProcessingResult;
    try {
      result = await processorConfig.onEvent(nextEvent);
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        shouldRetry: true,
      };
    }

    if (result.success) {
      // Mark as done
      await appendStatusUpdate(nextEvent.id, {
        status: "done",
      });
      
      // Record for deduplication
      await recordProcessed(nextEvent, dedupeKey);
      
      lastProcessedSeq = nextEvent.seq;
      console.log(`[processor] Successfully processed event ${nextEvent.id}`);
    } else {
      // Handle failure
      if (result.shouldRetry) {
        // Mark for retry - retry scheduler will handle this
        await appendStatusUpdate(nextEvent.id, {
          status: "retry_scheduled",
          lastError: result.error ?? null,
        });
        console.log(`[processor] Event ${nextEvent.id} failed, scheduled for retry: ${result.error}`);
      } else {
        // Permanent failure - will go to DLQ
        await appendStatusUpdate(nextEvent.id, {
          status: "dead_lettered",
          lastError: result.error ?? null,
        });
        console.log(`[processor] Event ${nextEvent.id} permanently failed: ${result.error}`);

        // Check DLQ overflow threshold and trigger escalation if needed
        const DLQ_THRESHOLD = 100;
        const dlqSize = listDLQ().length;
        if (dlqSize > DLQ_THRESHOLD) {
          await handleDlqOverflow(dlqSize, DLQ_THRESHOLD, { eventId: nextEvent.id });
        }
      }
    }

    return true;
  } finally {
    isProcessing = false;
  }
}

/**
 * Process all pending events sequentially.
 * Returns the number of events processed.
 */
export async function processPending(): Promise<number> {
  let count = 0;
  
  while (await processNext()) {
    count++;
  }
  
  return count;
}

/**
 * Get the count of pending events.
 */
export async function getPendingCount(): Promise<number> {
  let count = 0;

  for await (const event of readFrom(lastProcessedSeq + 1)) {
    // Only count non-internal pending events
    if (event.status === "pending" && !event.type.startsWith("__")) {
      count++;
    }
  }

  return count;
}

/**
 * Get the last processed sequence number.
 */
export function getLastProcessedSeq(): number {
  return lastProcessedSeq;
}

/**
 * Reset the processor state (for testing).
 */
export async function resetProcessor(): Promise<void> {
  dedupeState = {
    version: 1,
    entries: [],
    lastCleanupAt: new Date().toISOString(),
  };
  await saveDedupeState();
  lastProcessedSeq = 0;
  isProcessing = false;
}

/**
 * Get dedupe statistics.
 */
export function getDedupeStats(): {
  totalEntries: number;
  lastCleanupAt: string;
  retentionDays: number;
} {
  return {
    totalEntries: dedupeState?.entries.length ?? 0,
    lastCleanupAt: dedupeState?.lastCleanupAt ?? new Date().toISOString(),
    retentionDays: processorConfig?.retentionDays ?? DEFAULT_RETENTION_DAYS,
  };
}

/**
 * Check if a specific dedupe key exists.
 * Useful for testing and debugging.
 */
export function hasDedupeKey(key: string): boolean {
  return isDuplicate(key);
}
