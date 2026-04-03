/**
 * Pause Controller
 * 
 * Durable pause/resume control with explicit operating modes.
 * 
 * DESIGN:
 * - Pause state stored at .claude/claudeclaw/paused.json
 * - Supports modes: "admission_only" | "admission_and_scheduling"
 * - Gateway and orchestrator must check pause state before processing
 * - All pause/resume actions generate audit records
 * 
 * CRASH CONSCIOUSNESS:
 * - Pause state is persisted immediately
 * - State survives restart and is applied during startup reconstruction
 * - No in-memory-only pause decisions
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log as logAudit } from "../policy/audit-log";

// ============================================================================
// Types
// ============================================================================

export type PauseMode = "admission_only" | "admission_and_scheduling";

export interface PauseState {
  paused: boolean;
  mode: PauseMode;
  reason?: string;
  pausedAt?: string;
  pausedBy?: string;
  resumeAt?: string;
  resumedAt?: string;
  resumedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface PauseAction {
  actionId: string;
  action: "pause" | "resume";
  mode?: PauseMode;
  reason: string;
  actor: string;
  timestamp: string;
  previousState?: PauseState;
  newState: PauseState;
}

export interface PauseOptions {
  reason?: string;
  pausedBy?: string;
  resumeAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ResumeOptions {
  reason?: string;
  resumedBy?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const PAUSE_STATE_FILE = join(ESCALATION_DIR, "paused.json");
const PAUSE_ACTIONS_FILE = join(ESCALATION_DIR, "pause-actions.jsonl");

// Default empty state
const DEFAULT_STATE: PauseState = {
  paused: false,
  mode: "admission_only",
};

// In-memory cache (source of truth is always the file)
let cachedState: PauseState | null = null;
let initializationPromise: Promise<void> | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the pause controller.
 * Ensures directories exist and loads initial state.
 */
export async function initPauseController(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  // Ensure directory exists
  await mkdir(ESCALATION_DIR, { recursive: true });

  // Try to load existing state
  cachedState = await loadPauseState();

  // If no state exists, create default unpaused state
  if (!cachedState) {
    cachedState = { ...DEFAULT_STATE };
    await savePauseState(cachedState);
  }
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Pause the system.
 * 
 * @param mode - Pause mode: "admission_only" or "admission_and_scheduling"
 * @param options - Pause options including reason, actor, and metadata
 * @returns The pause action record
 * 
 * Semantics:
 * - "admission_only": Reject/defer new inbound work, allow running work to complete
 * - "admission_and_scheduling": Reject/defer new work AND stop scheduling new tasks
 */
export async function pause(
  mode: PauseMode,
  options: PauseOptions = {}
): Promise<PauseAction> {
  await initPauseController();

  const now = new Date().toISOString();
  const previousState = { ...cachedState! };

  const newState: PauseState = {
    paused: true,
    mode,
    reason: options.reason,
    pausedAt: now,
    pausedBy: options.pausedBy || "system",
    resumeAt: options.resumeAt,
    resumedAt: undefined,
    resumedBy: undefined,
    metadata: options.metadata,
  };

  // Persist state
  await savePauseState(newState);
  cachedState = newState;

  // Record action
  const action: PauseAction = {
    actionId: randomUUID(),
    action: "pause",
    mode,
    reason: options.reason || "Paused by operator",
    actor: options.pausedBy || "system",
    timestamp: now,
    previousState,
    newState,
  };

  await recordPauseAction(action);

  // Log to audit log
  await logAudit({
    timestamp: now,
    eventId: `pause-${action.actionId}`,
    requestId: action.actionId,
    source: "escalation",
    toolName: "PauseController",
    action: "require_approval", // Using require_approval to indicate intervention
    reason: `System paused: ${options.reason || "No reason provided"}`,
    operatorId: options.pausedBy,
    metadata: { mode, resumeAt: options.resumeAt },
  });

  console.log(`[pause] System paused: mode=${mode}, reason=${options.reason || "N/A"}`);

  return action;
}

/**
 * Resume the system.
 * 
 * @param options - Resume options including reason and actor
 * @returns The resume action record
 */
export async function resume(
  options: ResumeOptions = {}
): Promise<PauseAction> {
  await initPauseController();

  const now = new Date().toISOString();
  const previousState = { ...cachedState! };

  // Only resume if currently paused
  if (!previousState.paused) {
    console.log("[pause] System is not paused, no action taken");
    return {
      actionId: randomUUID(),
      action: "resume",
      reason: options.reason || "Resume requested (system already running)",
      actor: options.resumedBy || "system",
      timestamp: now,
      previousState,
      newState: previousState,
    };
  }

  const newState: PauseState = {
    paused: false,
    mode: previousState.mode, // Keep last mode for reference
    reason: previousState.reason, // Keep reason for audit trail
    pausedAt: previousState.pausedAt,
    pausedBy: previousState.pausedBy,
    resumeAt: undefined,
    resumedAt: now,
    resumedBy: options.resumedBy || "system",
    metadata: { ...previousState.metadata, ...options.metadata },
  };

  // Persist state
  await savePauseState(newState);
  cachedState = newState;

  // Record action
  const action: PauseAction = {
    actionId: randomUUID(),
    action: "resume",
    reason: options.reason || "Resumed by operator",
    actor: options.resumedBy || "system",
    timestamp: now,
    previousState,
    newState,
  };

  await recordPauseAction(action);

  // Log to audit log
  await logAudit({
    timestamp: now,
    eventId: `resume-${action.actionId}`,
    requestId: action.actionId,
    source: "escalation",
    toolName: "PauseController",
    action: "allow", // Using allow to indicate normal operation restored
    reason: `System resumed: ${options.reason || "No reason provided"}`,
    operatorId: options.resumedBy,
    metadata: { previousPausedAt: previousState.pausedAt, previousPausedBy: previousState.pausedBy },
  });

  console.log(`[pause] System resumed: reason=${options.reason || "N/A"}`);

  return action;
}

/**
 * Get the current pause state.
 * Always reads from disk to ensure consistency.
 */
export async function getPauseState(): Promise<PauseState> {
  await initPauseController();

  const state = await loadPauseState();
  if (state) {
    cachedState = state;
    return state;
  }

  return { ...DEFAULT_STATE };
}

/**
 * Check if the system is currently paused.
 * This is a convenience method for quick checks.
 */
export async function isPaused(): Promise<boolean> {
  const state = await getPauseState();
  return state.paused;
}

/**
 * Check if new work admission should be blocked.
 * Returns true if paused (regardless of mode).
 */
export async function shouldBlockAdmission(): Promise<boolean> {
  const state = await getPauseState();
  return state.paused;
}

/**
 * Check if task scheduling should be blocked.
 * Returns true only in "admission_and_scheduling" mode.
 */
export async function shouldBlockScheduling(): Promise<boolean> {
  const state = await getPauseState();
  return state.paused && state.mode === "admission_and_scheduling";
}

// ============================================================================
// Pause Action History
// ============================================================================

/**
 * Get the history of pause/resume actions.
 */
export async function getPauseHistory(limit: number = 100): Promise<PauseAction[]> {
  if (!existsSync(PAUSE_ACTIONS_FILE)) {
    return [];
  }

  try {
    const content = await readFile(PAUSE_ACTIONS_FILE, "utf8");
    const lines = content.split("\n").filter(line => line.trim());

    const actions: PauseAction[] = [];

    for (const line of lines) {
      try {
        const action: PauseAction = JSON.parse(line);
        actions.push(action);
      } catch {
        // Skip malformed entries
        continue;
      }
    }

    // Sort by timestamp descending (newest first)
    actions.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return actions.slice(0, limit);
  } catch {
    return [];
  }
}

// ============================================================================
// Internal Functions
// ============================================================================

async function loadPauseState(): Promise<PauseState | null> {
  try {
    if (!existsSync(PAUSE_STATE_FILE)) {
      return null;
    }

    const content = await readFile(PAUSE_STATE_FILE, "utf8");
    const parsed = JSON.parse(content);

    // Validate required fields
    if (typeof parsed.paused !== "boolean") {
      return null;
    }

    return {
      paused: parsed.paused,
      mode: parsed.mode === "admission_and_scheduling" ? "admission_and_scheduling" : "admission_only",
      reason: parsed.reason,
      pausedAt: parsed.pausedAt,
      pausedBy: parsed.pausedBy,
      resumeAt: parsed.resumeAt,
      resumedAt: parsed.resumedAt,
      resumedBy: parsed.resumedBy,
      metadata: parsed.metadata,
    };
  } catch {
    return null;
  }
}

async function savePauseState(state: PauseState): Promise<void> {
  await writeFile(PAUSE_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function recordPauseAction(action: PauseAction): Promise<void> {
  const line = JSON.stringify(action) + "\n";
  
  let existingContent = "";
  try {
    if (existsSync(PAUSE_ACTIONS_FILE)) {
      existingContent = await readFile(PAUSE_ACTIONS_FILE, "utf8");
    }
  } catch {
    // File doesn't exist yet
  }

  await writeFile(PAUSE_ACTIONS_FILE, existingContent + line, "utf8");
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Reset the pause controller state (for testing only).
 */
export async function resetPauseController(): Promise<void> {
  cachedState = null;
  initializationPromise = null;
  
  try {
    if (existsSync(PAUSE_STATE_FILE)) {
      await writeFile(PAUSE_STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2) + "\n", "utf8");
    }
  } catch {
    // Ignore
  }
}

/**
 * Clear the pause controller cache without modifying state (for testing only).
 */
export function clearPauseCache(): void {
  cachedState = null;
  initializationPromise = null;
}
