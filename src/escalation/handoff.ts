/**
 * Handoff Manager
 * 
 * Create durable, reviewable handoff packages from workflow/session/event context.
 * 
 * DESIGN:
 * - Handoff packages stored at .claude/claudeclaw/handoffs/
 * - Each handoff is a durable snapshot for human review
 * - References workflow/task/session/event context accurately
 * - Supports create, get, list, accept, and close operations
 * - Handoff acceptance modeled explicitly
 * 
 * CRASH CONSCIOUSNESS:
 * - Handoff records are persisted immediately
 * - State survives restart
 * - No in-memory-only handoff data
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log as logAudit } from "../policy/audit-log";

// ============================================================================
// Types
// ============================================================================

export type HandoffSeverity = "info" | "warning" | "critical";
export type HandoffStatus = "open" | "accepted" | "closed";

export interface PendingEvent {
  eventId: string;
  type: string;
  status: string;
}

export interface HandoffPackage {
  handoffId: string;
  createdAt: string;
  reason: string;
  severity: HandoffSeverity;
  status: HandoffStatus;
  workflowIds?: string[];
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  relatedEventIds?: string[];
  pendingTasks?: string[];
  pendingApprovals?: string[];
  pendingEvents?: PendingEvent[];
  summary: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  
  // Lifecycle tracking
  acceptedAt?: string;
  acceptedBy?: string;
  closedAt?: string;
  closedBy?: string;
  resolution?: string;
}

export interface HandoffContext {
  workflowIds?: string[];
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  relatedEventIds?: string[];
  pendingTasks?: string[];
  pendingApprovals?: string[];
  pendingEvents?: PendingEvent[];
}

export interface CreateHandoffOptions {
  severity?: HandoffSeverity;
  summary?: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
}

export interface AcceptHandoffOptions {
  acceptedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface CloseHandoffOptions {
  closedBy?: string;
  resolution?: string;
  metadata?: Record<string, unknown>;
}

export interface HandoffFilters {
  status?: HandoffStatus;
  severity?: HandoffSeverity;
  source?: string;
  sessionId?: string;
  workflowId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

// ============================================================================
// Constants
// ============================================================================

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const HANDOFFS_DIR = join(ESCALATION_DIR, "handoffs");
const HANDOFF_INDEX_FILE = join(HANDOFFS_DIR, "index.json");
const HANDOFF_ACTIONS_FILE = join(ESCALATION_DIR, "handoff-actions.jsonl");

interface HandoffIndex {
  version: number;
  handoffs: Record<string, HandoffSummary>;
  updatedAt: string;
}

interface HandoffSummary {
  handoffId: string;
  createdAt: string;
  reason: string;
  severity: HandoffSeverity;
  status: HandoffStatus;
  source?: string;
  sessionId?: string;
  closedAt?: string;
}

interface HandoffAction {
  actionId: string;
  handoffId: string;
  action: "create" | "accept" | "close" | "update";
  actor: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

// In-memory cache (source of truth is always the files)
let handoffIndex: HandoffIndex | null = null;
let initializationPromise: Promise<void> | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the handoff manager.
 * Ensures directories exist and loads initial index.
 */
export async function initHandoffManager(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  // Ensure directories exist
  await mkdir(ESCALATION_DIR, { recursive: true });
  await mkdir(HANDOFFS_DIR, { recursive: true });

  // Try to load existing index
  handoffIndex = await loadHandoffIndex();

  // If no index exists, create default
  if (!handoffIndex) {
    handoffIndex = {
      version: 1,
      handoffs: {},
      updatedAt: new Date().toISOString(),
    };
    await saveHandoffIndex();
  }
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Create a new handoff package.
 * 
 * @param reason - The reason for creating the handoff
 * @param context - Context including workflow/session/event references
 * @param options - Additional options including severity and summary
 * @returns The created handoff package
 */
export async function createHandoff(
  reason: string,
  context: HandoffContext = {},
  options: CreateHandoffOptions = {}
): Promise<HandoffPackage> {
  await initHandoffManager();

  const now = new Date().toISOString();
  const handoffId = randomUUID();

  const handoff: HandoffPackage = {
    handoffId,
    createdAt: now,
    reason,
    severity: options.severity || "info",
    status: "open",
    workflowIds: context.workflowIds,
    sessionId: context.sessionId,
    claudeSessionId: context.claudeSessionId,
    source: context.source,
    channelId: context.channelId,
    threadId: context.threadId,
    relatedEventIds: context.relatedEventIds,
    pendingTasks: context.pendingTasks,
    pendingApprovals: context.pendingApprovals,
    pendingEvents: context.pendingEvents,
    summary: options.summary || reason,
    attachments: options.attachments,
    metadata: options.metadata,
  };

  // Persist handoff package
  await saveHandoffPackage(handoff);

  // Update index
  handoffIndex!.handoffs[handoffId] = {
    handoffId,
    createdAt: now,
    reason,
    severity: handoff.severity,
    status: "open",
    source: context.source,
    sessionId: context.sessionId,
  };
  await saveHandoffIndex();

  // Record action
  await recordHandoffAction({
    actionId: randomUUID(),
    handoffId,
    action: "create",
    actor: "system",
    timestamp: now,
    details: { severity: handoff.severity, source: context.source },
  });

  // Log to audit log
  await logAudit({
    timestamp: now,
    eventId: `handoff-${handoffId}`,
    requestId: handoffId,
    source: context.source || "escalation",
    toolName: "HandoffManager",
    action: "require_approval",
    reason: `Handoff created: ${reason}`,
    metadata: {
      handoffId,
      severity: handoff.severity,
      sessionId: context.sessionId,
      workflowIds: context.workflowIds,
    },
  });

  console.log(`[handoff] Created handoff ${handoffId}: ${reason} (${handoff.severity})`);

  return handoff;
}

/**
 * Get a handoff package by ID.
 * 
 * @param handoffId - The handoff ID
 * @returns The handoff package or null if not found
 */
export async function getHandoff(handoffId: string): Promise<HandoffPackage | null> {
  await initHandoffManager();

  return await loadHandoffPackage(handoffId);
}

/**
 * List handoffs with optional filters.
 * 
 * @param filters - Optional filters for status, severity, source, etc.
 * @returns Array of matching handoff summaries
 */
export async function listHandoffs(filters: HandoffFilters = {}): Promise<HandoffSummary[]> {
  await initHandoffManager();

  let handoffs = Object.values(handoffIndex!.handoffs);

  // Apply filters
  if (filters.status) {
    handoffs = handoffs.filter(h => h.status === filters.status);
  }

  if (filters.severity) {
    handoffs = handoffs.filter(h => h.severity === filters.severity);
  }

  if (filters.source) {
    handoffs = handoffs.filter(h => h.source === filters.source);
  }

  if (filters.sessionId) {
    handoffs = handoffs.filter(h => h.sessionId === filters.sessionId);
  }

  if (filters.workflowId) {
    handoffs = handoffs.filter(h => 
      h.handoffId === filters.workflowId // For now, direct ID match
    );
  }

  if (filters.createdAfter) {
    handoffs = handoffs.filter(h => h.createdAt >= filters.createdAfter!);
  }

  if (filters.createdBefore) {
    handoffs = handoffs.filter(h => h.createdAt <= filters.createdBefore!);
  }

  // Sort by createdAt descending (newest first)
  handoffs.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return handoffs;
}

/**
 * Accept a handoff.
 * Marks the handoff as accepted by an operator.
 * 
 * @param handoffId - The handoff ID
 * @param options - Accept options including actor and metadata
 * @returns The updated handoff package or null if not found
 */
export async function acceptHandoff(
  handoffId: string,
  options: AcceptHandoffOptions = {}
): Promise<HandoffPackage | null> {
  await initHandoffManager();

  const handoff = await loadHandoffPackage(handoffId);
  if (!handoff) {
    return null;
  }

  // Can only accept open handoffs
  if (handoff.status !== "open") {
    console.warn(`[handoff] Cannot accept handoff ${handoffId}: status is ${handoff.status}`);
    return handoff;
  }

  const now = new Date().toISOString();

  // Update handoff
  handoff.status = "accepted";
  handoff.acceptedAt = now;
  handoff.acceptedBy = options.acceptedBy || "operator";
  
  if (options.metadata) {
    handoff.metadata = { ...handoff.metadata, ...options.metadata };
  }

  // Persist changes
  await saveHandoffPackage(handoff);

  // Update index
  handoffIndex!.handoffs[handoffId].status = "accepted";
  await saveHandoffIndex();

  // Record action
  await recordHandoffAction({
    actionId: randomUUID(),
    handoffId,
    action: "accept",
    actor: handoff.acceptedBy,
    timestamp: now,
  });

  // Log to audit log
  await logAudit({
    timestamp: now,
    eventId: `handoff-accept-${handoffId}`,
    requestId: handoffId,
    source: "escalation",
    toolName: "HandoffManager",
    action: "approved",
    reason: `Handoff accepted: ${handoff.reason}`,
    operatorId: handoff.acceptedBy,
    metadata: { handoffId },
  });

  console.log(`[handoff] Accepted handoff ${handoffId} by ${handoff.acceptedBy}`);

  return handoff;
}

/**
 * Close a handoff.
 * Marks the handoff as closed with an optional resolution.
 * 
 * @param handoffId - The handoff ID
 * @param options - Close options including actor, resolution, and metadata
 * @returns The updated handoff package or null if not found
 */
export async function closeHandoff(
  handoffId: string,
  options: CloseHandoffOptions = {}
): Promise<HandoffPackage | null> {
  await initHandoffManager();

  const handoff = await loadHandoffPackage(handoffId);
  if (!handoff) {
    return null;
  }

  // Can close from any status
  const now = new Date().toISOString();

  // Update handoff
  handoff.status = "closed";
  handoff.closedAt = now;
  handoff.closedBy = options.closedBy || "operator";
  handoff.resolution = options.resolution;
  
  if (options.metadata) {
    handoff.metadata = { ...handoff.metadata, ...options.metadata };
  }

  // Persist changes
  await saveHandoffPackage(handoff);

  // Update index
  handoffIndex!.handoffs[handoffId].status = "closed";
  handoffIndex!.handoffs[handoffId].closedAt = now;
  await saveHandoffIndex();

  // Record action
  await recordHandoffAction({
    actionId: randomUUID(),
    handoffId,
    action: "close",
    actor: handoff.closedBy,
    timestamp: now,
    details: { resolution: options.resolution },
  });

  // Log to audit log
  await logAudit({
    timestamp: now,
    eventId: `handoff-close-${handoffId}`,
    requestId: handoffId,
    source: "escalation",
    toolName: "HandoffManager",
    action: "allow",
    reason: `Handoff closed: ${options.resolution || "No resolution provided"}`,
    operatorId: handoff.closedBy,
    metadata: { handoffId, resolution: options.resolution },
  });

  console.log(`[handoff] Closed handoff ${handoffId} by ${handoff.closedBy}`);

  return handoff;
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get handoff statistics.
 */
export async function getHandoffStats(): Promise<{
  total: number;
  byStatus: Record<HandoffStatus, number>;
  bySeverity: Record<HandoffSeverity, number>;
  openCritical: number;
}> {
  await initHandoffManager();

  const handoffs = Object.values(handoffIndex!.handoffs);
  
  const byStatus: Record<HandoffStatus, number> = { open: 0, accepted: 0, closed: 0 };
  const bySeverity: Record<HandoffSeverity, number> = { info: 0, warning: 0, critical: 0 };
  
  let openCritical = 0;

  for (const h of handoffs) {
    byStatus[h.status] = (byStatus[h.status] || 0) + 1;
    bySeverity[h.severity] = (bySeverity[h.severity] || 0) + 1;
    
    if (h.status === "open" && h.severity === "critical") {
      openCritical++;
    }
  }

  return {
    total: handoffs.length,
    byStatus,
    bySeverity,
    openCritical,
  };
}

// ============================================================================
// Internal Functions
// ============================================================================

async function loadHandoffIndex(): Promise<HandoffIndex | null> {
  try {
    if (!existsSync(HANDOFF_INDEX_FILE)) {
      return null;
    }

    const content = await readFile(HANDOFF_INDEX_FILE, "utf8");
    const parsed = JSON.parse(content);

    if (parsed.version === 1 && typeof parsed.handoffs === "object") {
      return parsed as HandoffIndex;
    }

    return null;
  } catch {
    return null;
  }
}

async function saveHandoffIndex(): Promise<void> {
  if (!handoffIndex) return;

  handoffIndex.updatedAt = new Date().toISOString();
  await writeFile(HANDOFF_INDEX_FILE, JSON.stringify(handoffIndex, null, 2) + "\n", "utf8");
}

function getHandoffFilePath(handoffId: string): string {
  return join(HANDOFFS_DIR, `${handoffId}.json`);
}

async function loadHandoffPackage(handoffId: string): Promise<HandoffPackage | null> {
  try {
    const filePath = getHandoffFilePath(handoffId);
    
    if (!existsSync(filePath)) {
      return null;
    }

    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as HandoffPackage;
  } catch {
    return null;
  }
}

async function saveHandoffPackage(handoff: HandoffPackage): Promise<void> {
  const filePath = getHandoffFilePath(handoff.handoffId);
  await writeFile(filePath, JSON.stringify(handoff, null, 2) + "\n", "utf8");
}

async function recordHandoffAction(action: HandoffAction): Promise<void> {
  const line = JSON.stringify(action) + "\n";
  
  let existingContent = "";
  try {
    if (existsSync(HANDOFF_ACTIONS_FILE)) {
      existingContent = await readFile(HANDOFF_ACTIONS_FILE, "utf8");
    }
  } catch {
    // File doesn't exist yet
  }

  await writeFile(HANDOFF_ACTIONS_FILE, existingContent + line, "utf8");
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Reset the handoff manager (for testing only).
 */
export async function resetHandoffManager(): Promise<void> {
  handoffIndex = null;
  initializationPromise = null;
}

/**
 * Clear the handoff manager cache without modifying state (for testing only).
 */
export function clearHandoffCache(): void {
  handoffIndex = null;
  initializationPromise = null;
}
