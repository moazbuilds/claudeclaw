/**
 * Replay Support
 * 
 * Allows intentional reprocessing of events.
 * 
 * SAFETY:
 * - Replay never mutates existing done records
 * - Replay always creates new event records
 * - Replay events carry replayedFromEventId for provenance
 * - Can replay from: sequence number, range, or DLQ
 * 
 * USE CASES:
 * - Recover from processor bugs by reprocessing affected events
 * - Backfill new functionality across historical events
 * - Retry DLQ events after fixing root cause
 */

import { initEventLog, append, readFrom, readRange, type EventRecord, type EventEntryInput } from "./event-log";
import { initDLQ, replay as replayDLQEntry, list as listDLQ, type DLQEntry } from "./dead-letter-queue";

export interface ReplayResult {
  originalSeq: number;
  originalEventId: string;
  newSeq: number;
  newEventId: string;
  success: boolean;
  error?: string;
}

export interface ReplaySummary {
  requested: number;
  successful: number;
  failed: number;
  results: ReplayResult[];
}

/**
 * Initialize replay system.
 */
export async function initReplay(): Promise<void> {
  await initEventLog();
  await initDLQ();
}

/**
 * Replay all events from a given sequence number.
 * Creates new events for each original event.
 */
export async function replayFrom(startSeq: number): Promise<ReplaySummary> {
  await initReplay();

  const results: ReplayResult[] = [];
  let successful = 0;
  let failed = 0;

  for await (const event of readFrom(startSeq)) {
    const result = await replaySingleEvent(event);
    results.push(result);

    if (result.success) {
      successful++;
    } else {
      failed++;
    }
  }

  console.log(
    `[replay] Replay from seq ${startSeq} complete: ${successful} successful, ${failed} failed`
  );

  return {
    requested: results.length,
    successful,
    failed,
    results,
  };
}

/**
 * Replay events in a sequence range (inclusive).
 */
export async function replayRange(
  startSeq: number,
  endSeq: number
): Promise<ReplaySummary> {
  await initReplay();

  const results: ReplayResult[] = [];
  let successful = 0;
  let failed = 0;

  for await (const event of readRange(startSeq, endSeq)) {
    const result = await replaySingleEvent(event);
    results.push(result);

    if (result.success) {
      successful++;
    } else {
      failed++;
    }
  }

  console.log(
    `[replay] Replay range ${startSeq}-${endSeq} complete: ${successful} successful, ${failed} failed`
  );

  return {
    requested: results.length,
    successful,
    failed,
    results,
  };
}

/**
 * Replay a specific event by ID.
 * Finds the event in the log and creates a replay.
 */
export async function replayEvent(eventId: string): Promise<ReplayResult | null> {
  await initReplay();

  // Find the event
  for await (const event of readFrom(1)) {
    if (event.id === eventId) {
      return replaySingleEvent(event);
    }
  }

  return null;
}

/**
 * Replay all events in the DLQ.
 */
export async function replayDLQ(): Promise<ReplaySummary> {
  await initReplay();

  const entries = listDLQ();
  const results: ReplayResult[] = [];
  let successful = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const newEvent = await replayDLQEntry(entry.id);

      if (newEvent) {
        results.push({
          originalSeq: entry.originalSeq,
          originalEventId: entry.originalEventId,
          newSeq: newEvent.seq,
          newEventId: newEvent.id,
          success: true,
        });
        successful++;
      } else {
        results.push({
          originalSeq: entry.originalSeq,
          originalEventId: entry.originalEventId,
          newSeq: 0,
          newEventId: "",
          success: false,
          error: "Replay returned null",
        });
        failed++;
      }
    } catch (err) {
      results.push({
        originalSeq: entry.originalSeq,
        originalEventId: entry.originalEventId,
        newSeq: 0,
        newEventId: "",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  console.log(
    `[replay] DLQ replay complete: ${successful} successful, ${failed} failed`
  );

  return {
    requested: entries.length,
    successful,
    failed,
    results,
  };
}

/**
 * Replay a single event.
 * Internal helper that creates a new event record.
 */
async function replaySingleEvent(originalEvent: EventRecord): Promise<ReplayResult> {
  try {
    const entry: EventEntryInput = {
      type: originalEvent.type,
      source: originalEvent.source,
      channelId: originalEvent.channelId,
      threadId: originalEvent.threadId,
      payload: originalEvent.payload,
      dedupeKey: `replay-${originalEvent.id}-${Date.now()}`, // Unique dedupe key for replay
      correlationId: originalEvent.correlationId,
      causationId: originalEvent.id, // Original event is the causation
      replayedFromEventId: originalEvent.id,
    };

    const newEvent = await append(entry);

    return {
      originalSeq: originalEvent.seq,
      originalEventId: originalEvent.id,
      newSeq: newEvent.seq,
      newEventId: newEvent.id,
      success: true,
    };
  } catch (err) {
    return {
      originalSeq: originalEvent.seq,
      originalEventId: originalEvent.id,
      newSeq: 0,
      newEventId: "",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Preview what would be replayed without actually doing it.
 * Useful for verifying replay scope before execution.
 */
export async function previewReplayFrom(startSeq: number): Promise<{
  count: number;
  firstSeq: number | null;
  lastSeq: number | null;
  eventTypes: string[];
}> {
  await initEventLog();

  const events: EventRecord[] = [];
  for await (const event of readFrom(startSeq)) {
    events.push(event);
  }

  if (events.length === 0) {
    return {
      count: 0,
      firstSeq: null,
      lastSeq: null,
      eventTypes: [],
    };
  }

  const types = [...new Set(events.map(e => e.type))];

  return {
    count: events.length,
    firstSeq: events[0].seq,
    lastSeq: events[events.length - 1].seq,
    eventTypes: types,
  };
}

/**
 * Preview what would be replayed in a range.
 */
export async function previewReplayRange(
  startSeq: number,
  endSeq: number
): Promise<{
  count: number;
  eventTypes: string[];
}> {
  await initEventLog();

  const events: EventRecord[] = [];
  for await (const event of readRange(startSeq, endSeq)) {
    events.push(event);
  }

  const types = [...new Set(events.map(e => e.type))];

  return {
    count: events.length,
    eventTypes: types,
  };
}

/**
 * Preview DLQ replay.
 */
export async function previewReplayDLQ(): Promise<{
  count: number;
  eventTypes: string[];
  oldestFailure: string | null;
  newestFailure: string | null;
}> {
  await initDLQ();

  const entries = listDLQ();

  if (entries.length === 0) {
    return {
      count: 0,
      eventTypes: [],
      oldestFailure: null,
      newestFailure: null,
    };
  }

  const types = [...new Set(entries.map(e => e.event.type))];
  const sorted = [...entries].sort(
    (a, b) => new Date(a.deadLetteredAt).getTime() - new Date(b.deadLetteredAt).getTime()
  );

  return {
    count: entries.length,
    eventTypes: types,
    oldestFailure: sorted[0].deadLetteredAt,
    newestFailure: sorted[sorted.length - 1].deadLetteredAt,
  };
}
