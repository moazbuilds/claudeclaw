/**
 * Durable Usage Tracker
 * 
 * Persisted per-invocation usage/accounting records with aggregate queries.
 * 
 * STORAGE MODEL:
 * - Records stored in .claude/claudeclaw/usage/
 * - Per-invocation: usage-{invocationId}.json
 * - Index: usage-index.json (maps invocationId to file)
 * - Usage logs: usage-{YYYYMMDD}.jsonl (daily rotation)
 * 
 * COST CALCULATION:
 * - Cost is ESTIMATED based on configurable pricing metadata
 * - Cost is NEVER presented as exact provider billing
 * - Pricing is versioned for auditability
 */

import { join } from "path";
import { existsSync } from "fs";
import { appendFile, readdir } from "fs/promises";
import { randomUUID } from "crypto";

const USAGE_DIR = join(process.cwd(), ".claude", "claudeclaw", "usage");
const USAGE_INDEX_FILE = join(USAGE_DIR, "usage-index.json");
const MAX_INDEX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export type InvocationStatus = "started" | "completed" | "failed" | "killed";

export interface UsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface EstimatedCost {
  currency: string;
  inputCost?: number;
  outputCost?: number;
  cacheCost?: number;
  totalCost?: number;
  pricingVersion?: string;
}

export interface InvocationUsageRecord {
  invocationId: string;
  eventId?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  provider: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  status: InvocationStatus;
  usage?: UsageMetrics;
  estimatedCost?: EstimatedCost;
  metadata?: Record<string, unknown>;
  error?: {
    type?: string;
    message: string;
  };
}

export interface InvocationContext {
  eventId?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  provider: string;
  model: string;
  metadata?: Record<string, unknown>;
}

interface UsageIndex {
  version: number;
  records: Record<string, string>; // invocationId -> filename
  updatedAt: string;
}

interface DailyUsageLog {
  date: string;
  records: string[];
}

// In-memory cache for performance
let usageIndex: UsageIndex | null = null;
let initializationPromise: Promise<void> | null = null;

// Write queue for serializing concurrent operations
let writeQueue: Promise<void> = Promise.resolve();
let writeQueueLength = 0;

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  writeQueueLength++;
  const promise = writeQueue.then(() => operation());
  writeQueue = promise.then(
    () => { writeQueueLength--; },
    () => { writeQueueLength--; }
  );
  return promise;
}

export function getWriteQueueLength(): number {
  return writeQueueLength;
}

export function resetUsageTracker(): void {
  usageIndex = null;
  initializationPromise = null;
  writeQueue = Promise.resolve();
  writeQueueLength = 0;
}

/**
 * Initialize the usage tracker system.
 */
export async function initUsageTracker(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  // Ensure directory exists
  await Bun.write(join(USAGE_DIR, ".gitkeep"), "");

  // Try to load existing index
  usageIndex = await loadUsageIndex();

  if (!usageIndex) {
    usageIndex = {
      version: 1,
      records: {},
      updatedAt: new Date().toISOString(),
    };
    await saveUsageIndex();
  }
}

async function loadUsageIndex(): Promise<UsageIndex | null> {
  try {
    if (!existsSync(USAGE_INDEX_FILE)) {
      return null;
    }
    const content = await Bun.file(USAGE_INDEX_FILE).json();
    if (content.version === 1 && typeof content.records === "object") {
      return content as UsageIndex;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveUsageIndex(): Promise<void> {
  if (!usageIndex) return;

  usageIndex.updatedAt = new Date().toISOString();
  await Bun.write(USAGE_INDEX_FILE, JSON.stringify(usageIndex, null, 2) + "\n");
}

function getInvocationFilePath(invocationId: string): string {
  return join(USAGE_DIR, `usage-${invocationId}.json`);
}

function getDailyLogFilePath(date: string): string {
  return join(USAGE_DIR, `usage-${date}.jsonl`);
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Record the start of an invocation.
 */
export async function recordInvocationStart(context: InvocationContext, invocationId?: string): Promise<InvocationUsageRecord> {
  await initUsageTracker();

  return enqueueWrite(async () => {
    const now = new Date().toISOString();
    const record: InvocationUsageRecord = {
      invocationId: invocationId ?? randomUUID(),
      eventId: context.eventId,
      sessionId: context.sessionId,
      claudeSessionId: context.claudeSessionId ?? null,
      source: context.source,
      channelId: context.channelId,
      threadId: context.threadId,
      provider: context.provider,
      model: context.model,
      startedAt: now,
      status: "started",
      metadata: context.metadata,
    };

    // Save record
    const filePath = getInvocationFilePath(record.invocationId);
    await Bun.write(filePath, JSON.stringify(record, null, 2) + "\n");

    // Update index
    if (usageIndex) {
      usageIndex.records[record.invocationId] = filePath;
      await saveUsageIndex();
    }

    // Append to daily log
    const today = getTodayDate();
    const dailyLogPath = getDailyLogFilePath(today);
    const logEntry = JSON.stringify({
      invocationId: record.invocationId,
      timestamp: now,
      type: "start",
    }) + "\n";
    
    await appendFile(dailyLogPath, logEntry);

    return record;
  });
}

/**
 * Record the completion of an invocation with usage metrics.
 */
export async function recordInvocationCompletion(
  invocationId: string,
  usage?: UsageMetrics,
  estimatedCost?: EstimatedCost
): Promise<InvocationUsageRecord | null> {
  await initUsageTracker();

  return enqueueWrite(async () => {
    const record = await loadInvocationRecord(invocationId);
    if (!record) {
      console.warn(`[usage-tracker] Invocation ${invocationId} not found for completion`);
      return null;
    }

    const now = new Date().toISOString();
    record.status = "completed";
    record.completedAt = now;
    record.usage = usage;
    record.estimatedCost = estimatedCost;

    // Save updated record
    const filePath = getInvocationFilePath(invocationId);
    await Bun.write(filePath, JSON.stringify(record, null, 2) + "\n");

    // Append to daily log
    const today = getTodayDate();
    const dailyLogPath = getDailyLogFilePath(today);
    const logEntry = JSON.stringify({
      invocationId: record.invocationId,
      timestamp: now,
      type: "completion",
      usage,
      estimatedCost,
    }) + "\n";
    
    await appendFile(dailyLogPath, logEntry);

    return record;
  });
}

/**
 * Record the failure of an invocation.
 */
export async function recordInvocationFailure(
  invocationId: string,
  error: { type?: string; message: string }
): Promise<InvocationUsageRecord | null> {
  await initUsageTracker();

  return enqueueWrite(async () => {
    const record = await loadInvocationRecord(invocationId);
    if (!record) {
      console.warn(`[usage-tracker] Invocation ${invocationId} not found for failure`);
      return null;
    }

    const now = new Date().toISOString();
    record.status = "failed";
    record.completedAt = now;
    record.error = error;

    // Save updated record
    const filePath = getInvocationFilePath(invocationId);
    await Bun.write(filePath, JSON.stringify(record, null, 2) + "\n");

    // Append to daily log
    const today = getTodayDate();
    const dailyLogPath = getDailyLogFilePath(today);
    const logEntry = JSON.stringify({
      invocationId: record.invocationId,
      timestamp: now,
      type: "failure",
      error,
    }) + "\n";
    
    await appendFile(dailyLogPath, logEntry);

    return record;
  });
}

/**
 * Record invocation killed by watchdog.
 */
export async function recordInvocationKilled(
  invocationId: string,
  reason: string
): Promise<InvocationUsageRecord | null> {
  await initUsageTracker();

  return enqueueWrite(async () => {
    const record = await loadInvocationRecord(invocationId);
    if (!record) {
      console.warn(`[usage-tracker] Invocation ${invocationId} not found for kill`);
      return null;
    }

    const now = new Date().toISOString();
    record.status = "killed";
    record.completedAt = now;
    record.error = { type: "watchdog", message: reason };

    // Save updated record
    const filePath = getInvocationFilePath(invocationId);
    await Bun.write(filePath, JSON.stringify(record, null, 2) + "\n");

    // Append to daily log
    const today = getTodayDate();
    const dailyLogPath = getDailyLogFilePath(today);
    const logEntry = JSON.stringify({
      invocationId: record.invocationId,
      timestamp: now,
      type: "killed",
      reason,
    }) + "\n";
    
    await appendFile(dailyLogPath, logEntry);

    return record;
  });
}

/**
 * Load an invocation record by ID.
 */
export async function getInvocation(invocationId: string): Promise<InvocationUsageRecord | null> {
  await initUsageTracker();
  return loadInvocationRecord(invocationId);
}

async function loadInvocationRecord(invocationId: string): Promise<InvocationUsageRecord | null> {
  const filePath = getInvocationFilePath(invocationId);
  
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return await Bun.file(filePath).json() as InvocationUsageRecord;
  } catch {
    return null;
  }
}

/**
 * Get usage for a specific session.
 */
export async function getSessionUsage(sessionId: string): Promise<InvocationUsageRecord[]> {
  await initUsageTracker();

  const records: InvocationUsageRecord[] = [];

  if (!usageIndex) {
    return records;
  }

  for (const [invocationId, filePath] of Object.entries(usageIndex.records)) {
    try {
      const record = await Bun.file(filePath).json() as InvocationUsageRecord;
      if (record.sessionId === sessionId) {
        records.push(record);
      }
    } catch {
      // Skip corrupted records
    }
  }

  return records;
}

/**
 * Get usage for a specific channel.
 */
export async function getChannelUsage(channelId: string): Promise<InvocationUsageRecord[]> {
  await initUsageTracker();

  const records: InvocationUsageRecord[] = [];

  if (!usageIndex) {
    return records;
  }

  for (const [invocationId, filePath] of Object.entries(usageIndex.records)) {
    try {
      const record = await Bun.file(filePath).json() as InvocationUsageRecord;
      if (record.channelId === channelId) {
        records.push(record);
      }
    } catch {
      // Skip corrupted records
    }
  }

  return records;
}

/**
 * Get usage filtered by various criteria.
 */
export interface UsageFilters {
  sessionId?: string;
  channelId?: string;
  source?: string;
  provider?: string;
  model?: string;
  status?: InvocationStatus;
  startDate?: string;
  endDate?: string;
}

export async function getAggregates(filters: UsageFilters = {}): Promise<{
  totalInvocations: number;
  completedInvocations: number;
  failedInvocations: number;
  killedInvocations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCost: number;
  byProvider: Record<string, { count: number; tokens: number; cost: number }>;
  byModel: Record<string, { count: number; tokens: number; cost: number }>;
  byChannel: Record<string, { count: number; tokens: number; cost: number }>;
  bySource: Record<string, { count: number; tokens: number; cost: number }>;
}> {
  await initUsageTracker();

  const result = {
    totalInvocations: 0,
    completedInvocations: 0,
    failedInvocations: 0,
    killedInvocations: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCost: 0,
    byProvider: {} as Record<string, { count: number; tokens: number; cost: number }>,
    byModel: {} as Record<string, { count: number; tokens: number; cost: number }>,
    byChannel: {} as Record<string, { count: number; tokens: number; cost: number }>,
    bySource: {} as Record<string, { count: number; tokens: number; cost: number }>,
  };

  if (!usageIndex) {
    return result;
  }

  for (const [invocationId, filePath] of Object.entries(usageIndex.records)) {
    try {
      const record = await Bun.file(filePath).json() as InvocationUsageRecord;

      // Apply filters
      if (filters.sessionId && record.sessionId !== filters.sessionId) continue;
      if (filters.channelId && record.channelId !== filters.channelId) continue;
      if (filters.source && record.source !== filters.source) continue;
      if (filters.provider && record.provider !== filters.provider) continue;
      if (filters.model && record.model !== filters.model) continue;
      if (filters.status && record.status !== filters.status) continue;
      if (filters.startDate && record.startedAt < filters.startDate) continue;
      if (filters.endDate && record.startedAt > filters.endDate) continue;

      // Count
      result.totalInvocations++;

      if (record.status === "completed") {
        result.completedInvocations++;
      } else if (record.status === "failed") {
        result.failedInvocations++;
      } else if (record.status === "killed") {
        result.killedInvocations++;
      }

      // Tokens
      const inputTokens = record.usage?.inputTokens ?? 0;
      const outputTokens = record.usage?.outputTokens ?? 0;
      const cacheCreationTokens = record.usage?.cacheCreationInputTokens ?? 0;
      const cacheReadTokens = record.usage?.cacheReadInputTokens ?? 0;

      result.totalInputTokens += inputTokens;
      result.totalOutputTokens += outputTokens;
      result.totalCacheCreationTokens += cacheCreationTokens;
      result.totalCacheReadTokens += cacheReadTokens;

      // Cost
      const cost = record.estimatedCost?.totalCost ?? 0;
      result.totalEstimatedCost += cost;

      // By provider
      if (!result.byProvider[record.provider]) {
        result.byProvider[record.provider] = { count: 0, tokens: 0, cost: 0 };
      }
      result.byProvider[record.provider].count++;
      result.byProvider[record.provider].tokens += inputTokens + outputTokens;
      result.byProvider[record.provider].cost += cost;

      // By model
      if (!result.byModel[record.model]) {
        result.byModel[record.model] = { count: 0, tokens: 0, cost: 0 };
      }
      result.byModel[record.model].count++;
      result.byModel[record.model].tokens += inputTokens + outputTokens;
      result.byModel[record.model].cost += cost;

      // By channel
      if (record.channelId) {
        if (!result.byChannel[record.channelId]) {
          result.byChannel[record.channelId] = { count: 0, tokens: 0, cost: 0 };
        }
        result.byChannel[record.channelId].count++;
        result.byChannel[record.channelId].tokens += inputTokens + outputTokens;
        result.byChannel[record.channelId].cost += cost;
      }

      // By source
      if (record.source) {
        if (!result.bySource[record.source]) {
          result.bySource[record.source] = { count: 0, tokens: 0, cost: 0 };
        }
        result.bySource[record.source].count++;
        result.bySource[record.source].tokens += inputTokens + outputTokens;
        result.bySource[record.source].cost += cost;
      }
    } catch {
      // Skip corrupted records
    }
  }

  return result;
}

/**
 * Get all usage records (for testing/admin).
 */
export async function getAllUsageRecords(): Promise<InvocationUsageRecord[]> {
  await initUsageTracker();

  const records: InvocationUsageRecord[] = [];

  if (!usageIndex) {
    return records;
  }

  for (const [invocationId, filePath] of Object.entries(usageIndex.records)) {
    try {
      const record = await Bun.file(filePath).json() as InvocationUsageRecord;
      records.push(record);
    } catch {
      // Skip corrupted records
    }
  }

  return records;
}

/**
 * Get usage tracker statistics.
 */
export async function getUsageStats(): Promise<{
  totalRecords: number;
  indexSizeBytes: number;
  directorySizeBytes: number;
}> {
  await initUsageTracker();

  let directorySizeBytes = 0;

  try {
    const files = await readdir(USAGE_DIR, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) {
        const size = Bun.file(join(USAGE_DIR, file.name)).size;
        directorySizeBytes += size;
      }
    }
  } catch {
    // Directory might not exist
  }

  return {
    totalRecords: usageIndex ? Object.keys(usageIndex.records).length : 0,
    indexSizeBytes: existsSync(USAGE_INDEX_FILE) 
      ? new TextEncoder().encode(JSON.stringify(usageIndex)).length 
      : 0,
    directorySizeBytes,
  };
}
