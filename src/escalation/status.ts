/**
 * Escalation Status View
 * 
 * Provide a durable read-side view of current pause/escalation/handoff status.
 * 
 * DESIGN:
 * - Status view derives from persisted escalation state
 * - Read-only view that aggregates pause, handoff, and notification status
 * - Provides a single source of truth for operator dashboards
 * - No hidden state - all derived from persisted files
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PauseState } from "./pause";
import type { HandoffPackage, HandoffStatus, HandoffSeverity } from "./handoff";
import type { EscalationNotification, NotificationType, NotificationSeverity } from "./notifications";

// ============================================================================
// Types
// ============================================================================

export interface EscalationStatus {
  timestamp: string;
  pause: PauseStatus;
  handoffs: HandoffSummary[];
  notifications: NotificationSummary[];
  recentActions: EscalationActionSummary[];
  summary: EscalationSummary;
}

export interface PauseStatus {
  paused: boolean;
  mode: "admission_only" | "admission_and_scheduling" | null;
  since: string | null;
  reason: string | null;
  pausedBy: string | null;
  willResumeAt: string | null;
}

export interface HandoffSummary {
  handoffId: string;
  createdAt: string;
  status: HandoffStatus;
  severity: HandoffSeverity;
  reason: string;
  source?: string;
  sessionId?: string;
  acceptedBy?: string;
  closedBy?: string;
}

export interface NotificationSummary {
  notificationId: string;
  createdAt: string;
  type: NotificationType;
  severity: NotificationSeverity;
  message: string;
  delivered: boolean;
  eventId?: string;
  workflowId?: string;
}

export interface EscalationActionSummary {
  actionId: string;
  timestamp: string;
  action: "pause" | "resume" | "handoff_created" | "handoff_accepted" | "handoff_closed" | "notification";
  actor: string;
  details?: Record<string, unknown>;
}

export interface EscalationSummary {
  totalHandoffs: number;
  openHandoffs: number;
  criticalHandoffs: number;
  totalNotifications24h: number;
  undeliveredNotifications: number;
  isPaused: boolean;
}

export interface StatusFilters {
  includeClosedHandoffs?: boolean;
  handoffLimit?: number;
  notificationLimit?: number;
  actionLimit?: number;
  since?: string;
}

// ============================================================================
// Constants
// ============================================================================

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const PAUSE_STATE_FILE = join(ESCALATION_DIR, "paused.json");
const HANDOFFS_DIR = join(ESCALATION_DIR, "handoffs");
const NOTIFICATIONS_DIR = join(ESCALATION_DIR, "notifications");
const PAUSE_ACTIONS_FILE = join(ESCALATION_DIR, "pause-actions.jsonl");
const HANDOFF_ACTIONS_FILE = join(ESCALATION_DIR, "handoff-actions.jsonl");

// ============================================================================
// Core API
// ============================================================================

/**
 * Get the complete escalation status.
 * This is the main entry point for status views.
 * 
 * @param filters - Optional filters for the status view
 * @returns The complete escalation status
 */
export async function getEscalationStatus(
  filters: StatusFilters = {}
): Promise<EscalationStatus> {
  const timestamp = new Date().toISOString();

  // Get all status components in parallel
  const [pause, handoffs, notifications, recentActions] = await Promise.all([
    getPauseStatus(),
    getHandoffSummaries(filters),
    getNotificationSummaries(filters),
    getRecentActions(filters),
  ]);

  // Calculate summary
  const summary: EscalationSummary = {
    totalHandoffs: handoffs.length,
    openHandoffs: handoffs.filter(h => h.status === "open").length,
    criticalHandoffs: handoffs.filter(h => h.severity === "critical" && h.status !== "closed").length,
    totalNotifications24h: notifications.filter(n => isWithinHours(n.createdAt, 24)).length,
    undeliveredNotifications: notifications.filter(n => !n.delivered).length,
    isPaused: pause.paused,
  };

  return {
    timestamp,
    pause,
    handoffs,
    notifications,
    recentActions,
    summary,
  };
}

/**
 * Get a summary of escalation status for quick checks.
 */
export async function getEscalationSummary(): Promise<EscalationSummary> {
  const [pauseStatus, handoffs, notifications] = await Promise.all([
    getPauseStatus(),
    getHandoffSummaries({ includeClosedHandoffs: true }),
    getNotificationSummaries({}),
  ]);

  return {
    totalHandoffs: handoffs.length,
    openHandoffs: handoffs.filter(h => h.status === "open").length,
    criticalHandoffs: handoffs.filter(h => h.severity === "critical" && h.status !== "closed").length,
    totalNotifications24h: notifications.filter(n => isWithinHours(n.createdAt, 24)).length,
    undeliveredNotifications: notifications.filter(n => !n.delivered).length,
    isPaused: pauseStatus.paused,
  };
}

/**
 * Check if the system requires operator attention.
 */
export async function requiresAttention(): Promise<{
  requiresAttention: boolean;
  reasons: string[];
}> {
  const status = await getEscalationStatus();
  const reasons: string[] = [];

  if (status.pause.paused) {
    reasons.push(`System is paused (${status.pause.mode})`);
  }

  if (status.summary.criticalHandoffs > 0) {
    reasons.push(`${status.summary.criticalHandoffs} critical handoffs require attention`);
  }

  if (status.summary.openHandoffs > 5) {
    reasons.push(`${status.summary.openHandoffs} open handoffs`);
  }

  if (status.summary.undeliveredNotifications > 10) {
    reasons.push(`${status.summary.undeliveredNotifications} undelivered notifications`);
  }

  return {
    requiresAttention: reasons.length > 0,
    reasons,
  };
}

// ============================================================================
// Component Status Functions
// ============================================================================

async function getPauseStatus(): Promise<PauseStatus> {
  try {
    if (!existsSync(PAUSE_STATE_FILE)) {
      return {
        paused: false,
        mode: null,
        since: null,
        reason: null,
        pausedBy: null,
        willResumeAt: null,
      };
    }

    const content = await readFile(PAUSE_STATE_FILE, "utf8");
    const state: PauseState = JSON.parse(content);

    return {
      paused: state.paused,
      mode: state.paused ? state.mode : null,
      since: state.pausedAt || null,
      reason: state.reason || null,
      pausedBy: state.pausedBy || null,
      willResumeAt: state.resumeAt || null,
    };
  } catch {
    return {
      paused: false,
      mode: null,
      since: null,
      reason: null,
      pausedBy: null,
      willResumeAt: null,
    };
  }
}

async function getHandoffSummaries(filters: StatusFilters): Promise<HandoffSummary[]> {
  const summaries: HandoffSummary[] = [];

  try {
    if (!existsSync(HANDOFFS_DIR)) {
      return summaries;
    }

    const files = await readdir(HANDOFFS_DIR);
    const jsonFiles = files.filter(f => f.endsWith(".json") && f !== "index.json");

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(HANDOFFS_DIR, file), "utf8");
        const handoff: HandoffPackage = JSON.parse(content);

        // Filter out closed handoffs unless requested
        if (!filters.includeClosedHandoffs && handoff.status === "closed") {
          continue;
        }

        // Filter by since date
        if (filters.since && handoff.createdAt < filters.since) {
          continue;
        }

        summaries.push({
          handoffId: handoff.handoffId,
          createdAt: handoff.createdAt,
          status: handoff.status,
          severity: handoff.severity,
          reason: handoff.reason,
          source: handoff.source,
          sessionId: handoff.sessionId,
          acceptedBy: handoff.acceptedBy,
          closedBy: handoff.closedBy,
        });
      } catch {
        // Skip malformed files
        continue;
      }
    }
  } catch {
    // Directory might not exist
  }

  // Sort by createdAt descending (newest first)
  summaries.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Apply limit
  const limit = filters.handoffLimit ?? 50;
  return summaries.slice(0, limit);
}

async function getNotificationSummaries(
  filters: StatusFilters
): Promise<NotificationSummary[]> {
  const summaries: NotificationSummary[] = [];

  try {
    if (!existsSync(NOTIFICATIONS_DIR)) {
      return summaries;
    }

    const files = await readdir(NOTIFICATIONS_DIR);
    const jsonFiles = files.filter(f => f.endsWith(".json"));

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(NOTIFICATIONS_DIR, file), "utf8");
        const notification: EscalationNotification = JSON.parse(content);

        // Filter by since date
        if (filters.since && notification.createdAt < filters.since) {
          continue;
        }

        summaries.push({
          notificationId: notification.notificationId,
          createdAt: notification.createdAt,
          type: notification.type,
          severity: notification.severity,
          message: notification.message,
          delivered: notification.delivery?.delivered ?? false,
          eventId: notification.eventId,
          workflowId: notification.workflowId,
        });
      } catch {
        // Skip malformed files
        continue;
      }
    }
  } catch {
    // Directory might not exist
  }

  // Sort by createdAt descending (newest first)
  summaries.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Apply limit
  const limit = filters.notificationLimit ?? 50;
  return summaries.slice(0, limit);
}

async function getRecentActions(filters: StatusFilters): Promise<EscalationActionSummary[]> {
  const actions: EscalationActionSummary[] = [];

  // Read pause actions
  try {
    if (existsSync(PAUSE_ACTIONS_FILE)) {
      const content = await readFile(PAUSE_ACTIONS_FILE, "utf8");
      const lines = content.split("\n").filter(line => line.trim());

      for (const line of lines) {
        try {
          const action = JSON.parse(line);
          if (filters.since && action.timestamp < filters.since) {
            continue;
          }

          actions.push({
            actionId: action.actionId,
            timestamp: action.timestamp,
            action: action.action === "pause" ? "pause" : "resume",
            actor: action.actor,
            details: { mode: action.mode, reason: action.reason },
          });
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Ignore
  }

  // Read handoff actions
  try {
    if (existsSync(HANDOFF_ACTIONS_FILE)) {
      const content = await readFile(HANDOFF_ACTIONS_FILE, "utf8");
      const lines = content.split("\n").filter(line => line.trim());

      for (const line of lines) {
        try {
          const action = JSON.parse(line);
          if (filters.since && action.timestamp < filters.since) {
            continue;
          }

          let actionType: EscalationActionSummary["action"];
          switch (action.action) {
            case "create":
              actionType = "handoff_created";
              break;
            case "accept":
              actionType = "handoff_accepted";
              break;
            case "close":
              actionType = "handoff_closed";
              break;
            default:
              actionType = "handoff_created";
          }

          actions.push({
            actionId: action.actionId,
            timestamp: action.timestamp,
            action: actionType,
            actor: action.actor,
            details: { handoffId: action.handoffId },
          });
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Ignore
  }

  // Sort by timestamp descending (newest first)
  actions.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Apply limit
  const limit = filters.actionLimit ?? 50;
  return actions.slice(0, limit);
}

// ============================================================================
// Helper Functions
// ============================================================================

function isWithinHours(timestamp: string, hours: number): boolean {
  const then = new Date(timestamp).getTime();
  const now = Date.now();
  const hoursInMs = hours * 60 * 60 * 1000;
  return now - then <= hoursInMs;
}

// ============================================================================
// Export Formatting
// ============================================================================

/**
 * Format escalation status for human-readable display.
 */
export function formatStatus(status: EscalationStatus): string {
  const lines: string[] = [];

  lines.push("═".repeat(60));
  lines.push("ESCALATION STATUS");
  lines.push("═".repeat(60));
  lines.push(`Generated: ${status.timestamp}`);
  lines.push("");

  // Pause status
  lines.push("─".repeat(60));
  lines.push("PAUSE STATUS");
  lines.push("─".repeat(60));
  if (status.pause.paused) {
    lines.push(`⚠️  SYSTEM IS PAUSED`);
    lines.push(`   Mode: ${status.pause.mode}`);
    lines.push(`   Since: ${status.pause.since}`);
    lines.push(`   Reason: ${status.pause.reason || "N/A"}`);
    lines.push(`   Paused By: ${status.pause.pausedBy || "N/A"}`);
    if (status.pause.willResumeAt) {
      lines.push(`   Auto-resume: ${status.pause.willResumeAt}`);
    }
  } else {
    lines.push("✅ System is running normally");
  }
  lines.push("");

  // Handoffs
  lines.push("─".repeat(60));
  lines.push(`HANDOFFS (${status.summary.openHandoffs} open, ${status.summary.criticalHandoffs} critical)`);
  lines.push("─".repeat(60));
  if (status.handoffs.length === 0) {
    lines.push("No handoffs");
  } else {
    for (const h of status.handoffs.slice(0, 10)) {
      let icon = "🔵";
      if (h.severity === "critical") {
        icon = "🔴";
      } else if (h.severity === "warning") {
        icon = "🟡";
      }
      lines.push(`${icon} [${h.status.toUpperCase()}] ${h.reason.slice(0, 50)}${h.reason.length > 50 ? "..." : ""}`);
      lines.push(`   ID: ${h.handoffId} | Created: ${h.createdAt}`);
    }
    if (status.handoffs.length > 10) {
      lines.push(`... and ${status.handoffs.length - 10} more`);
    }
  }
  lines.push("");

  // Notifications
  lines.push("─".repeat(60));
  lines.push(`NOTIFICATIONS (${status.summary.undeliveredNotifications} undelivered)`);
  lines.push("─".repeat(60));
  if (status.notifications.length === 0) {
    lines.push("No recent notifications");
  } else {
    for (const n of status.notifications.slice(0, 5)) {
      const icon = n.delivered ? "✅" : "📤";
      lines.push(`${icon} [${n.severity.toUpperCase()}] ${n.type}: ${n.message.slice(0, 40)}${n.message.length > 40 ? "..." : ""}`);
    }
    if (status.notifications.length > 5) {
      lines.push(`... and ${status.notifications.length - 5} more`);
    }
  }
  lines.push("");

  // Summary
  lines.push("─".repeat(60));
  lines.push("SUMMARY");
  lines.push("─".repeat(60));
  lines.push(`Total Handoffs: ${status.summary.totalHandoffs}`);
  lines.push(`Open Handoffs: ${status.summary.openHandoffs}`);
  lines.push(`Critical Handoffs: ${status.summary.criticalHandoffs}`);
  lines.push(`Notifications (24h): ${status.summary.totalNotifications24h}`);
  lines.push(`Undelivered Notifications: ${status.summary.undeliveredNotifications}`);
  lines.push("");
  lines.push("═".repeat(60));

  return lines.join("\n");
}

/**
 * Export status as JSON for API consumption.
 */
export function exportStatusAsJson(status: EscalationStatus): string {
  return JSON.stringify(status, null, 2);
}
