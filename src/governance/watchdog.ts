/**
 * Runaway Watchdog
 * 
 * Detects and controls runaway execution patterns safely and durably.
 * 
 * DESIGN PRINCIPLES:
 * - Watchdog monitors durable execution metrics per invocation/session
 * - "kill" is modeled as a governance outcome first, then mapped to execution control
 * - Actions flow through governance/event paths, not subprocess hacks
 * - Repeated-tool detection uses normalized signatures, not raw string comparison
 */

import { join } from "path";
import { existsSync } from "fs";
import { appendFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import { recordInvocationKilled } from "./usage-tracker";

const CLAUDECLAW_DIR = join(process.cwd(), ".claude", "claudeclaw");
const WATCHDOG_DIR = join(CLAUDECLAW_DIR, "watchdog");
const WATCHDOG_INDEX_FILE = join(WATCHDOG_DIR, "watchdog-index.json");
const WATCHDOG_EVENTS_FILE = join(WATCHDOG_DIR, "watchdog-events.jsonl");

export type WatchdogState = "healthy" | "warn" | "suspend" | "kill";

export interface WatchdogLimits {
  maxToolCalls?: number;
  maxTurns?: number;
  maxRuntimeSeconds?: number;
  maxRepeatedTools?: number;
  repeatedToolThreshold?: number; // Number of repeated patterns before action
}

export interface ExecutionMetrics {
  invocationId: string;
  sessionId?: string;
  toolCallCount: number;
  turnCount: number;
  toolCalls: Array<{
    tool: string;
    inputHash: string;
    timestamp: string;
  }>;
  startedAt: string;
  lastActivityAt: string;
}

export interface WatchdogDecision {
  invocationId: string;
  state: WatchdogState;
  reason: string;
  triggeredLimits: string[];
  recommendedAction: string;
  evaluatedAt: string;
}

export interface WatchdogConfig {
  limits: WatchdogLimits;
  enabled: boolean;
  checkIntervalMs: number;
}

interface WatchdogEventRecord {
  id: string;
  invocationId: string;
  sessionId?: string;
  decision: WatchdogDecision;
  executedAction?: string;
  timestamp: string;
}

interface WatchdogIndex {
  version: number;
  activeInvocations: Record<string, ExecutionMetrics>;
  updatedAt: string;
}

// Default configuration
let watchdogConfig: WatchdogConfig = {
  limits: {
    maxToolCalls: 100,
    maxTurns: 50,
    maxRuntimeSeconds: 600, // 10 minutes
    maxRepeatedTools: 5,
    repeatedToolThreshold: 3, // 3+ repeated patterns triggers warning
  },
  enabled: true,
  checkIntervalMs: 5000, // Check every 5 seconds
};

// In-memory state
let watchdogIndex: WatchdogIndex | null = null;
let initializationPromise: Promise<void> | null = null;

export function resetWatchdog(): void {
  watchdogIndex = null;
  initializationPromise = null;
}

/**
 * Configure the watchdog.
 */
export function configureWatchdog(config: Partial<WatchdogConfig>): void {
  watchdogConfig = {
    ...watchdogConfig,
    limits: {
      ...watchdogConfig.limits,
      ...config.limits,
    },
    enabled: config.enabled ?? watchdogConfig.enabled,
    checkIntervalMs: config.checkIntervalMs ?? watchdogConfig.checkIntervalMs,
  };
}

/**
 * Get current watchdog configuration.
 */
export function getWatchdogConfig(): WatchdogConfig {
  return { ...watchdogConfig };
}

/**
 * Initialize the watchdog system.
 */
export async function initWatchdog(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  // Ensure directory exists
  await Bun.write(join(WATCHDOG_DIR, ".gitkeep"), "");

  // Try to load existing index
  watchdogIndex = await loadWatchdogIndex();

  if (!watchdogIndex) {
    watchdogIndex = {
      version: 1,
      activeInvocations: {},
      updatedAt: new Date().toISOString(),
    };
    await saveWatchdogIndex();
  }
}

async function loadWatchdogIndex(): Promise<WatchdogIndex | null> {
  try {
    if (!existsSync(WATCHDOG_INDEX_FILE)) {
      return null;
    }
    const content = await Bun.file(WATCHDOG_INDEX_FILE).json();
    if (content.version === 1 && typeof content.activeInvocations === "object") {
      return content as WatchdogIndex;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveWatchdogIndex(): Promise<void> {
  if (!watchdogIndex) return;

  watchdogIndex.updatedAt = new Date().toISOString();
  await Bun.write(WATCHDOG_INDEX_FILE, JSON.stringify(watchdogIndex, null, 2) + "\n");
}

async function appendWatchdogEvent(event: WatchdogEventRecord): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await mkdir(WATCHDOG_DIR, { recursive: true });
  await appendFile(WATCHDOG_EVENTS_FILE, line);
}

/**
 * Normalize a tool call for comparison.
 * Uses input hash to detect repeated patterns.
 */
function normalizeToolCall(tool: string, input: unknown): { tool: string; inputHash: string } {
  const normalizedTool = tool.toLowerCase().replace(/[^a-z0-9]/g, "");
  const inputStr = JSON.stringify(input) || "";
  // Simple hash for comparison
  let hash = 0;
  for (let i = 0; i < inputStr.length; i++) {
    const char = inputStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const inputHash = Math.abs(hash).toString(16);

  return { tool: normalizedTool, inputHash };
}

/**
 * Detect repeated tool call patterns.
 */
function detectRepeatedPatterns(
  toolCalls: Array<{ tool: string; inputHash: string; timestamp: string }>
): { pattern: string; count: number }[] {
  const patterns: Record<string, number> = {};

  for (const call of toolCalls) {
    const key = `${call.tool}:${call.inputHash}`;
    patterns[key] = (patterns[key] || 0) + 1;
  }

  return Object.entries(patterns)
    .filter(([, count]) => count >= (watchdogConfig.limits.repeatedToolThreshold || 3))
    .map(([pattern, count]) => {
      const [tool, hash] = pattern.split(":");
      return { pattern: `${tool}(hash=${hash.slice(0, 8)})`, count };
    });
}

/**
 * Record execution metrics for an invocation.
 */
export async function recordExecutionMetric(
  context: {
    invocationId: string;
    sessionId?: string;
  },
  metrics: {
    toolCallCount?: number;
    turnCount?: number;
    toolCalls?: Array<{ tool: string; input: unknown; timestamp?: string }>;
  }
): Promise<void> {
  await initWatchdog();

  const now = new Date().toISOString();

  if (!watchdogIndex!.activeInvocations[context.invocationId]) {
    watchdogIndex!.activeInvocations[context.invocationId] = {
      invocationId: context.invocationId,
      sessionId: context.sessionId,
      toolCallCount: 0,
      turnCount: 0,
      toolCalls: [],
      startedAt: now,
      lastActivityAt: now,
    };
  }

  const record = watchdogIndex!.activeInvocations[context.invocationId];

  if (metrics.toolCallCount !== undefined) {
    record.toolCallCount = metrics.toolCallCount;
  }

  if (metrics.turnCount !== undefined) {
    record.turnCount = metrics.turnCount;
  }

  if (metrics.toolCalls) {
    record.toolCalls = metrics.toolCalls.map((tc) => {
      const normalized = normalizeToolCall(tc.tool, tc.input);
      return {
        tool: normalized.tool,
        inputHash: normalized.inputHash,
        timestamp: tc.timestamp || now,
      };
    });
  }

  record.lastActivityAt = now;

  await saveWatchdogIndex();
}

/**
 * Increment tool call count for an invocation.
 */
export async function incrementToolCall(
  invocationId: string,
  tool: string,
  input: unknown
): Promise<void> {
  await initWatchdog();

  const now = new Date().toISOString();
  const normalized = normalizeToolCall(tool, input);

  if (!watchdogIndex!.activeInvocations[invocationId]) {
    watchdogIndex!.activeInvocations[invocationId] = {
      invocationId,
      toolCallCount: 0,
      turnCount: 0,
      toolCalls: [],
      startedAt: now,
      lastActivityAt: now,
    };
  }

  const record = watchdogIndex!.activeInvocations[invocationId];
  record.toolCallCount++;
  record.toolCalls.push({
    tool: normalized.tool,
    inputHash: normalized.inputHash,
    timestamp: now,
  });
  record.lastActivityAt = now;

  await saveWatchdogIndex();
}

/**
 * Increment turn count for an invocation.
 */
export async function incrementTurnCount(invocationId: string): Promise<void> {
  await initWatchdog();

  const now = new Date().toISOString();

  if (!watchdogIndex!.activeInvocations[invocationId]) {
    watchdogIndex!.activeInvocations[invocationId] = {
      invocationId,
      toolCallCount: 0,
      turnCount: 0,
      toolCalls: [],
      startedAt: now,
      lastActivityAt: now,
    };
  }

  watchdogIndex!.activeInvocations[invocationId].turnCount++;
  watchdogIndex!.activeInvocations[invocationId].lastActivityAt = now;

  await saveWatchdogIndex();
}

/**
 * Check limits for an invocation.
 */
export async function checkLimits(
  context: {
    invocationId: string;
    sessionId?: string;
  }
): Promise<WatchdogDecision> {
  await initWatchdog();

  const now = new Date().toISOString();
  const record = watchdogIndex!.activeInvocations[context.invocationId];

  if (!record) {
    // No metrics recorded yet - assume healthy
    return {
      invocationId: context.invocationId,
      state: "healthy",
      reason: "No execution metrics recorded",
      triggeredLimits: [],
      recommendedAction: "continue",
      evaluatedAt: now,
    };
  }

  const triggeredLimits: string[] = [];
  let worstState: WatchdogState = "healthy";

  const { limits } = watchdogConfig;

  // Check tool call limit
  if (limits.maxToolCalls && record.toolCallCount >= limits.maxToolCalls) {
    triggeredLimits.push(`maxToolCalls=${record.toolCallCount}/${limits.maxToolCalls}`);
    worstState = worstState === "healthy" ? "suspend" : worstState;
  } else if (limits.maxToolCalls && record.toolCallCount >= limits.maxToolCalls * 0.8) {
    triggeredLimits.push(`maxToolCalls_warning=${record.toolCallCount}/${limits.maxToolCalls}`);
    if (worstState === "healthy") worstState = "warn";
  }

  // Check turn limit
  if (limits.maxTurns && record.turnCount >= limits.maxTurns) {
    triggeredLimits.push(`maxTurns=${record.turnCount}/${limits.maxTurns}`);
    worstState = worstState === "healthy" ? "suspend" : worstState;
  } else if (limits.maxTurns && record.turnCount >= limits.maxTurns * 0.8) {
    triggeredLimits.push(`maxTurns_warning=${record.turnCount}/${limits.maxTurns}`);
    if (worstState === "healthy") worstState = "warn";
  }

  // Check runtime limit
  if (limits.maxRuntimeSeconds) {
    const startedAt = new Date(record.startedAt);
    const elapsedSeconds = (Date.now() - startedAt.getTime()) / 1000;
    if (elapsedSeconds >= limits.maxRuntimeSeconds) {
      triggeredLimits.push(`maxRuntimeSeconds=${elapsedSeconds}/${limits.maxRuntimeSeconds}`);
      worstState = worstState === "healthy" ? "suspend" : worstState;
    } else if (elapsedSeconds >= limits.maxRuntimeSeconds * 0.8) {
      triggeredLimits.push(`maxRuntimeSeconds_warning=${elapsedSeconds}/${limits.maxRuntimeSeconds}`);
      if (worstState === "healthy") worstState = "warn";
    }
  }

  // Check repeated tool patterns
  if (limits.maxRepeatedTools) {
    const repeatedPatterns = detectRepeatedPatterns(record.toolCalls);
    const totalRepeatedCalls = repeatedPatterns.reduce((sum, p) => sum + p.count, 0);
    if (totalRepeatedCalls >= limits.maxRepeatedTools) {
      triggeredLimits.push(
        `maxRepeatedTools=${totalRepeatedCalls}/${limits.maxRepeatedTools} (patterns: ${repeatedPatterns.map(p => `${p.pattern}=${p.count}`).join(", ")})`
      );
      worstState = worstState === "healthy" ? "suspend" : worstState;
    } else if (totalRepeatedCalls >= limits.maxRepeatedTools * 0.7) {
      triggeredLimits.push(
        `maxRepeatedTools_warning=${totalRepeatedCalls}/${limits.maxRepeatedTools}`
      );
      if (worstState === "healthy") worstState = "warn";
    }
  }

  // Determine reason and recommended action
  let reason = "Execution within normal parameters";
  let recommendedAction = "continue";

  if (triggeredLimits.length > 0) {
    reason = `Limits triggered: ${triggeredLimits.join(", ")}`;
    // Note: kill state escalation requires explicit handling at execution layer
    // suspend is the highest state returned by checkLimits
    recommendedAction = worstState === "suspend" ? "pause" : "review";
  }

  const decision: WatchdogDecision = {
    invocationId: context.invocationId,
    state: worstState,
    reason,
    triggeredLimits,
    recommendedAction,
    evaluatedAt: now,
  };

  // Record watchdog event
  const eventRecord: WatchdogEventRecord = {
    id: randomUUID(),
    invocationId: context.invocationId,
    sessionId: context.sessionId,
    decision,
    timestamp: now,
  };
  await appendWatchdogEvent(eventRecord);

  return decision;
}

/**
 * Handle a watchdog trigger.
 * This maps watchdog decisions to actual execution control.
 */
export async function handleTrigger(
  context: {
    invocationId: string;
    sessionId?: string;
  },
  decision: WatchdogDecision
): Promise<{ action: string; success: boolean }> {
  await initWatchdog();

  const now = new Date().toISOString();

  switch (decision.state) {
    case "kill":
      // Record kill in usage tracker for audit
      await recordInvocationKilled(
        context.invocationId,
        `Watchdog kill: ${decision.reason}`
      );

      // Remove from active invocations
      delete watchdogIndex!.activeInvocations[context.invocationId];
      await saveWatchdogIndex();

      // Log the event
      const killEvent: WatchdogEventRecord = {
        id: randomUUID(),
        invocationId: context.invocationId,
        sessionId: context.sessionId,
        decision,
        executedAction: "killed",
        timestamp: now,
      };
      await appendWatchdogEvent(killEvent);

      return {
        action: "terminated",
        success: true,
      };

    case "suspend":
      // Suspend is advisory - execution should pause but not terminate
      // This would need support from the execution layer
      const suspendEvent: WatchdogEventRecord = {
        id: randomUUID(),
        invocationId: context.invocationId,
        sessionId: context.sessionId,
        decision,
        executedAction: "suspended",
        timestamp: now,
      };
      await appendWatchdogEvent(suspendEvent);

      return {
        action: "suspended",
        success: true,
      };

    case "warn":
      // Just log the warning
      const warnEvent: WatchdogEventRecord = {
        id: randomUUID(),
        invocationId: context.invocationId,
        sessionId: context.sessionId,
        decision,
        executedAction: "warned",
        timestamp: now,
      };
      await appendWatchdogEvent(warnEvent);

      return {
        action: "warning_logged",
        success: true,
      };

    case "healthy":
    default:
      return {
        action: "no_action",
        success: true,
      };
  }
}

/**
 * Get active invocation metrics.
 */
export async function getActiveInvocation(
  invocationId: string
): Promise<ExecutionMetrics | null> {
  await initWatchdog();
  return watchdogIndex?.activeInvocations[invocationId] || null;
}

/**
 * Get all active invocations for a session.
 */
export async function getSessionActiveInvocations(
  sessionId: string
): Promise<ExecutionMetrics[]> {
  await initWatchdog();

  const invocations: ExecutionMetrics[] = [];

  if (!watchdogIndex) {
    return invocations;
  }

  for (const record of Object.values(watchdogIndex.activeInvocations)) {
    if (record.sessionId === sessionId) {
      invocations.push(record);
    }
  }

  return invocations;
}

/**
 * Clear an invocation from the watchdog (when completed normally).
 */
export async function clearInvocation(invocationId: string): Promise<void> {
  await initWatchdog();

  if (watchdogIndex?.activeInvocations[invocationId]) {
    delete watchdogIndex.activeInvocations[invocationId];
    await saveWatchdogIndex();
  }
}

/**
 * Get watchdog statistics.
 */
export async function getWatchdogStats(): Promise<{
  activeInvocations: number;
  eventsLogged: number;
  config: WatchdogConfig;
}> {
  await initWatchdog();

  let eventsLogged = 0;
  try {
    if (existsSync(WATCHDOG_EVENTS_FILE)) {
      const content = await Bun.file(WATCHDOG_EVENTS_FILE).text();
      eventsLogged = content.trim().split("\n").filter((l) => l.trim()).length;
    }
  } catch {
    // File might not exist
  }

  return {
    activeInvocations: watchdogIndex ? Object.keys(watchdogIndex.activeInvocations).length : 0,
    eventsLogged,
    config: { ...watchdogConfig },
  };
}
