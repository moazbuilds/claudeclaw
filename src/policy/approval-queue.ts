/**
 * Approval Workflow
 * 
 * Durable approval workflow for requests that require operator authorization.
 * 
 * DESIGN:
 * - Approval requests are durably stored in append-friendly format
 * - Storage path: .claude/claudeclaw/approval-queue.jsonl
 * - Queue state must not live only in memory
 * - Approval resolution is restart-safe
 * 
 * CRASH CONSCIOUSNESS:
 * - All queue operations use atomic file operations
 * - State is loaded from disk on init and kept in sync
 * - Approval must result in controlled continuation path
 */

import { appendFile, readFile, mkdir, stat, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { type ToolRequestContext, type PolicyDecision } from "./engine";

// ============================================================================
// Types
// ============================================================================

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  eventId: string;
  request: ToolRequestContext;
  decision: PolicyDecision;
  requestedAt: string;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  deniedBy?: string;
  deniedAt?: string;
  resolutionReason?: string;
  expiresAt?: string;
}

export interface ApprovalEntry extends ApprovalRequest {
  id: string;
  createdAt: string;
}

// ============================================================================
// Constants
// ============================================================================

const APPROVAL_DIR = join(process.cwd(), ".claude", "claudeclaw");
const APPROVAL_QUEUE_FILE = join(APPROVAL_DIR, "approval-queue.jsonl");
const APPROVAL_INDEX_FILE = join(APPROVAL_DIR, "approval-index.json");
const DEFAULT_EXPIRY_HOURS = 24;

// ============================================================================
// State
// ============================================================================

let approvalIndex: Map<string, ApprovalEntry> = new Map();
let indexLoadedAt: string = "";

// ============================================================================
// Core API
// ============================================================================

/**
 * Enqueue a request that requires approval.
 * Returns the approval entry with generated ID.
 */
export async function enqueue(
  request: ToolRequestContext,
  decision: PolicyDecision
): Promise<ApprovalEntry> {
  const now = new Date();
  const expiryDate = new Date(now.getTime() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);
  
  const entry: ApprovalEntry = {
    id: randomUUID(),
    eventId: request.eventId,
    request,
    decision,
    requestedAt: now.toISOString(),
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: expiryDate.toISOString(),
  };
  
  // Ensure directory exists
  await mkdir(APPROVAL_DIR, { recursive: true });
  
  // Append to queue file (atomic append)
  const line = JSON.stringify(entry) + "\n";
  await appendFile(APPROVAL_QUEUE_FILE, line, "utf8");
  
  // Update in-memory index
  approvalIndex.set(entry.id, entry);
  
  return entry;
}

/**
 * Approve a pending approval request.
 */
export async function approve(
  eventId: string,
  actor: string,
  reason?: string
): Promise<ApprovalEntry | null> {
  const entry = await findByEventId(eventId);
  if (!entry) {
    return null;
  }
  
  if (entry.status !== "pending") {
    // Already resolved - idempotent operation
    return entry;
  }
  
  const now = new Date().toISOString();
  
  // Update entry
  entry.status = "approved";
  entry.approvedBy = actor;
  entry.approvedAt = now;
  entry.resolutionReason = reason;
  
  // Persist to queue file
  await appendResolution(entry);
  
  // Update index
  approvalIndex.set(entry.id, entry);
  
  return entry;
}

/**
 * Deny a pending approval request.
 */
export async function deny(
  eventId: string,
  actor: string,
  reason?: string
): Promise<ApprovalEntry | null> {
  const entry = await findByEventId(eventId);
  if (!entry) {
    return null;
  }
  
  if (entry.status !== "pending") {
    // Already resolved - idempotent operation
    return entry;
  }
  
  const now = new Date().toISOString();
  
  // Update entry
  entry.status = "denied";
  entry.deniedBy = actor;
  entry.deniedAt = now;
  entry.resolutionReason = reason;
  
  // Persist to queue file
  await appendResolution(entry);
  
  // Update index
  approvalIndex.set(entry.id, entry);
  
  return entry;
}

/**
 * List all pending approval requests.
 */
export function listPending(): ApprovalEntry[] {
  const pending: ApprovalEntry[] = [];
  
  for (const entry of approvalIndex.values()) {
    if (entry.status === "pending") {
      // Check if expired
      if (entry.expiresAt) {
        const expiryDate = new Date(entry.expiresAt);
        if (expiryDate < new Date()) {
          continue; // Skip expired
        }
      }
      pending.push(entry);
    }
  }
  
  // Sort by requestedAt (oldest first)
  pending.sort((a, b) => 
    new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime()
  );
  
  return pending;
}

/**
 * Load state from disk.
 * Rebuilds in-memory index from queue file.
 * Since we always append to the file, the last occurrence of each ID is the latest state.
 */
export async function loadState(): Promise<void> {
  approvalIndex.clear();
  
  // Ensure directory exists
  if (!existsSync(APPROVAL_DIR)) {
    await mkdir(APPROVAL_DIR, { recursive: true });
    indexLoadedAt = new Date().toISOString();
    return;
  }
  
  // Check if queue file exists
  if (!existsSync(APPROVAL_QUEUE_FILE)) {
    indexLoadedAt = new Date().toISOString();
    return;
  }
  
  try {
    const content = await readFile(APPROVAL_QUEUE_FILE, "utf8");
    const lines = content.split("\n").filter(line => line.trim());
    
    // Since we always append and never modify existing lines,
    // the LAST occurrence of each ID in the file is the most recent state.
    // So we iterate in order and just overwrite with the latest.
    for (const line of lines) {
      try {
        const entry: ApprovalEntry = JSON.parse(line);
        approvalIndex.set(entry.id, entry);
      } catch {
        // Skip malformed lines
        continue;
      }
    }
  } catch {
    // File doesn't exist or can't be read - start fresh
  }
  
  indexLoadedAt = new Date().toISOString();
}

/**
 * Get the last time state was loaded.
 */
export function getLoadedAt(): string {
  return indexLoadedAt;
}

/**
 * Get entry by event ID.
 */
export async function findByEventId(eventId: string): Promise<ApprovalEntry | null> {
  // Search in memory first
  for (const entry of approvalIndex.values()) {
    if (entry.eventId === eventId) {
      return entry;
    }
  }
  
  // Fallback: search in file
  if (!existsSync(APPROVAL_QUEUE_FILE)) {
    return null;
  }
  
  try {
    const content = await readFile(APPROVAL_QUEUE_FILE, "utf8");
    const lines = content.split("\n").filter(line => line.trim());
    
    // Find most recent entry for this eventId
    let latest: ApprovalEntry | null = null;
    
    for (const line of lines) {
      try {
        const entry: ApprovalEntry = JSON.parse(line);
        if (entry.eventId === eventId) {
          if (!latest || new Date(entry.createdAt) > new Date(latest.createdAt)) {
            latest = entry;
          }
        }
      } catch {
        continue;
      }
    }
    
    return latest;
  } catch {
    return null;
  }
}

/**
 * Get entry by approval ID.
 */
export function findById(id: string): ApprovalEntry | null {
  return approvalIndex.get(id) || null;
}

/**
 * Check if an event is pending approval.
 */
export function isPending(eventId: string): boolean {
  const entry = approvalIndex.get(idFromEventId(eventId));
  return entry?.status === "pending";
}

// ============================================================================
// Internal Helpers
// ============================================================================

function idFromEventId(eventId: string): string | undefined {
  for (const [id, entry] of approvalIndex.entries()) {
    if (entry.eventId === eventId) {
      return id;
    }
  }
  return undefined;
}

async function appendResolution(entry: ApprovalEntry): Promise<void> {
  // Append updated entry as new line
  const line = JSON.stringify(entry) + "\n";
  await appendFile(APPROVAL_QUEUE_FILE, line, "utf8");
}

// ============================================================================
// Initialization
// ============================================================================

// Auto-load state on module import
loadState().catch(err => {
  console.error("Failed to load approval queue state:", err);
});
