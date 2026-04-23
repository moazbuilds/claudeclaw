/**
 * Notification Manager
 * 
 * Generate durable escalation notifications and support clean delivery abstractions.
 * 
 * DESIGN:
 * - Notification records stored durably at .claude/claudeclaw/notifications/
 * - Supports triggers: DLQ overflow, watchdog, policy denial, errors, manual escalation, pause/resume
 * - Rate limiting and deduplication to prevent spam
 * - Delivery abstraction supports webhook/email skeletons
 * - Notification record is canonical; delivery is best-effort
 * 
 * CRASH CONSCIOUSNESS:
 * - All notifications are persisted immediately
 * - Delivery failure does not erase the notification record
 * - Rate limiting state survives restart
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log as logAudit } from "../policy/audit-log";

// ============================================================================
// Types
// ============================================================================

export type NotificationType =
  | "dlq_overflow"
  | "watchdog"
  | "policy_denial"
  | "error"
  | "manual_escalation"
  | "pause"
  | "resume";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface EscalationNotification {
  notificationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  createdAt: string;
  eventId?: string;
  workflowId?: string;
  sessionId?: string;
  message: string;
  details?: Record<string, unknown>;
  delivery?: NotificationDelivery;
}

export interface NotificationDelivery {
  attempted: boolean;
  delivered?: boolean;
  channel?: string;
  error?: string;
  attemptedAt?: string;
  deliveredAt?: string;
}

export interface EscalationConfig {
  webhookUrl?: string;
  emailTarget?: string;
  rateLimits?: {
    perTypePerMinute?: number;
    perSeverityPerMinute?: number;
  };
  enabledTypes?: NotificationType[];
  minSeverity?: NotificationSeverity;
}

export interface NotificationFilters {
  type?: NotificationType;
  severity?: NotificationSeverity;
  eventId?: string;
  workflowId?: string;
  sessionId?: string;
  createdAfter?: string;
  createdBefore?: string;
  undeliveredOnly?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const NOTIFICATIONS_DIR = join(ESCALATION_DIR, "notifications");
const RATE_LIMIT_FILE = join(ESCALATION_DIR, "notification-rate-limits.json");
const CONFIG_FILE = join(ESCALATION_DIR, "notification-config.json");

const DEFAULT_RATE_LIMITS = {
  perTypePerMinute: 10,
  perSeverityPerMinute: 20,
};

const DEFAULT_CONFIG: EscalationConfig = {
  rateLimits: DEFAULT_RATE_LIMITS,
  enabledTypes: [
    "dlq_overflow",
    "watchdog",
    "policy_denial",
    "error",
    "manual_escalation",
    "pause",
    "resume",
  ],
  minSeverity: "info",
};

// Rate limit tracking (in-memory, backed by file)
interface RateLimitState {
  typeCounts: Record<string, Array<{ timestamp: string; count: number }>>;
  severityCounts: Record<string, Array<{ timestamp: string; count: number }>>;
  lastDedupeKeys: Record<string, string>;
  updatedAt: string;
}

let rateLimitState: RateLimitState | null = null;
let config: EscalationConfig = { ...DEFAULT_CONFIG };
let initializationPromise: Promise<void> | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the notification manager.
 */
export async function initNotificationManager(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  // Ensure directories exist
  await mkdir(ESCALATION_DIR, { recursive: true });
  await mkdir(NOTIFICATIONS_DIR, { recursive: true });

  // Load rate limit state
  rateLimitState = await loadRateLimitState();
  if (!rateLimitState) {
    rateLimitState = {
      typeCounts: {},
      severityCounts: {},
      lastDedupeKeys: {},
      updatedAt: new Date().toISOString(),
    };
    await saveRateLimitState();
  }

  // Load config
  const loadedConfig = await loadConfig();
  if (loadedConfig) {
    config = { ...DEFAULT_CONFIG, ...loadedConfig };
  }
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Create and persist a notification.
 * 
 * @param type - The notification type
 * @param severity - The notification severity
 * @param message - The notification message
 * @param context - Context including event/workflow/session IDs
 * @returns The created notification or null if rate limited/deduped
 */
export async function notify(
  type: NotificationType,
  severity: NotificationSeverity,
  message: string,
  context?: {
    eventId?: string;
    workflowId?: string;
    sessionId?: string;
    details?: Record<string, unknown>;
  }
): Promise<EscalationNotification | null> {
  await initNotificationManager();

  // Check if type is enabled
  if (config.enabledTypes && !config.enabledTypes.includes(type)) {
    console.log(`[notification] Type ${type} is disabled, skipping`);
    return null;
  }

  // Check minimum severity
  const severityOrder: NotificationSeverity[] = ["info", "warning", "critical"];
  if (config.minSeverity) {
    const configIndex = severityOrder.indexOf(config.minSeverity);
    const severityIndex = severityOrder.indexOf(severity);
    if (severityIndex < configIndex) {
      console.log(`[notification] Severity ${severity} below minimum ${config.minSeverity}, skipping`);
      return null;
    }
  }

  // Check deduplication
  const dedupeKey = generateDedupeKey(type, severity, message, context);
  if (isDuplicate(type, dedupeKey)) {
    console.log(`[notification] Duplicate notification suppressed: ${type}`);
    return null;
  }

  // Check rate limits
  if (isRateLimited(type, severity)) {
    console.warn(`[notification] Rate limited: ${type} (${severity})`);
    return null;
  }

  const now = new Date().toISOString();
  const notificationId = randomUUID();

  const notification: EscalationNotification = {
    notificationId,
    type,
    severity,
    createdAt: now,
    eventId: context?.eventId,
    workflowId: context?.workflowId,
    sessionId: context?.sessionId,
    message,
    details: context?.details,
    delivery: {
      attempted: false,
    },
  };

  // Persist notification
  await saveNotification(notification);

  // Update rate limits
  recordNotification(type, severity, dedupeKey);

  // Log to audit log
  await logAudit({
    timestamp: now,
    eventId: `notification-${notificationId}`,
    requestId: notificationId,
    source: "escalation",
    toolName: "NotificationManager",
    action: severity === "critical" ? "require_approval" : "allow",
    reason: `Notification: ${message}`,
    metadata: { type, severity, eventId: context?.eventId },
  });

  // Attempt delivery if configured
  if (config.webhookUrl || config.emailTarget) {
    await attemptDelivery(notification);
  }

  console.log(`[notification] Created ${type} (${severity}): ${message.slice(0, 50)}...`);

  return notification;
}

/**
 * List notifications with optional filters.
 */
export async function listNotifications(
  filters: NotificationFilters = {},
  limit: number = 100
): Promise<EscalationNotification[]> {
  await initNotificationManager();

  const notifications: EscalationNotification[] = [];

  try {
    const files = await readdir(NOTIFICATIONS_DIR);
    const jsonFiles = files.filter(f => f.endsWith(".json"));

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(NOTIFICATIONS_DIR, file), "utf8");
        const notification: EscalationNotification = JSON.parse(content);

        // Apply filters
        if (filters.type && notification.type !== filters.type) continue;
        if (filters.severity && notification.severity !== filters.severity) continue;
        if (filters.eventId && notification.eventId !== filters.eventId) continue;
        if (filters.workflowId && notification.workflowId !== filters.workflowId) continue;
        if (filters.sessionId && notification.sessionId !== filters.sessionId) continue;
        if (filters.createdAfter && notification.createdAt < filters.createdAfter) continue;
        if (filters.createdBefore && notification.createdAt > filters.createdBefore) continue;
        if (filters.undeliveredOnly && notification.delivery?.delivered) continue;

        notifications.push(notification);
      } catch {
        // Skip malformed files
        continue;
      }
    }
  } catch {
    // Directory might not exist yet
  }

  // Sort by createdAt descending (newest first)
  notifications.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return notifications.slice(0, limit);
}

/**
 * Get a specific notification by ID.
 */
export async function getNotification(
  notificationId: string
): Promise<EscalationNotification | null> {
  await initNotificationManager();

  try {
    const filePath = join(NOTIFICATIONS_DIR, `${notificationId}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as EscalationNotification;
  } catch {
    return null;
  }
}

/**
 * Configure the notification manager.
 */
export async function configure(newConfig: EscalationConfig): Promise<void> {
  await initNotificationManager();

  config = {
    ...config,
    ...newConfig,
    rateLimits: {
      ...config.rateLimits,
      ...newConfig.rateLimits,
    },
  };

  await saveConfig();
  console.log("[notification] Configuration updated");
}

/**
 * Get current configuration.
 */
export function getConfig(): EscalationConfig {
  return { ...config };
}

/**
 * Retry delivery for an undelivered notification.
 */
export async function retryDelivery(
  notificationId: string
): Promise<{ success: boolean; error?: string }> {
  const notification = await getNotification(notificationId);
  if (!notification) {
    return { success: false, error: "Notification not found" };
  }

  if (notification.delivery?.delivered) {
    return { success: true, error: "Already delivered" };
  }

  if (!config.webhookUrl && !config.emailTarget) {
    return { success: false, error: "No delivery channels configured" };
  }

  return await attemptDelivery(notification);
}

// ============================================================================
// Delivery Abstractions
// ============================================================================

/**
 * Attempt to deliver a notification.
 * This is a skeleton implementation - real delivery would integrate with
 * actual webhook/email services.
 */
async function attemptDelivery(
  notification: EscalationNotification
): Promise<{ success: boolean; error?: string }> {
  const now = new Date().toISOString();
  
  notification.delivery = {
    ...notification.delivery,
    attempted: true,
    attemptedAt: now,
  };

  const results: { success: boolean; error?: string }[] = [];

  // Attempt webhook delivery
  if (config.webhookUrl) {
    results.push(await attemptWebhookDelivery(notification));
  }

  // Attempt email delivery
  if (config.emailTarget) {
    results.push(await attemptEmailDelivery(notification));
  }

  // Consider successful if any channel succeeded
  const anySuccess = results.some(r => r.success);
  
  if (anySuccess) {
    notification.delivery!.delivered = true;
    notification.delivery!.deliveredAt = now;
  } else {
    notification.delivery!.error = results.find(r => r.error)?.error;
  }

  // Update persisted notification
  await saveNotification(notification);

  return {
    success: anySuccess,
    error: anySuccess ? undefined : notification.delivery!.error,
  };
}

/**
 * Attempt webhook delivery (skeleton).
 */
async function attemptWebhookDelivery(
  notification: EscalationNotification
): Promise<{ success: boolean; error?: string }> {
  if (!config.webhookUrl) {
    return { success: false, error: "No webhook URL configured" };
  }

  // Skeleton implementation - in production, this would make an HTTP POST
  console.log(`[notification] Would send webhook to ${config.webhookUrl}`);
  console.log(`[notification] Payload: ${JSON.stringify(notification, null, 2).slice(0, 200)}...`);

  // Simulate success for now
  return { success: true };
}

/**
 * Attempt email delivery (skeleton).
 */
async function attemptEmailDelivery(
  notification: EscalationNotification
): Promise<{ success: boolean; error?: string }> {
  if (!config.emailTarget) {
    return { success: false, error: "No email target configured" };
  }

  // Skeleton implementation - in production, this would use an email service
  console.log(`[notification] Would send email to ${config.emailTarget}`);
  console.log(`[notification] Subject: [${notification.severity.toUpperCase()}] ${notification.type}`);

  // Simulate success for now
  return { success: true };
}

// ============================================================================
// Rate Limiting
// ============================================================================

function generateDedupeKey(
  type: NotificationType,
  severity: NotificationSeverity,
  message: string,
  context?: { eventId?: string }
): string {
  // Create a dedupe key based on type, severity, and message (first 100 chars)
  // Include eventId if available for event-specific deduplication
  const messageHash = message.slice(0, 100);
  return `${type}:${severity}:${context?.eventId || "no-event"}:${messageHash}`;
}

function isDuplicate(type: NotificationType, dedupeKey: string): boolean {
  if (!rateLimitState) return false;

  const lastKey = rateLimitState.lastDedupeKeys[type];
  if (lastKey === dedupeKey) {
    return true;
  }

  return false;
}

function isRateLimited(type: NotificationType, severity: NotificationSeverity): boolean {
  if (!rateLimitState) return false;

  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60000).toISOString();

  const limits = config.rateLimits || DEFAULT_RATE_LIMITS;

  // Check per-type limit
  if (limits.perTypePerMinute) {
    const typeEntries = rateLimitState.typeCounts[type] || [];
    const recentTypeEntries = typeEntries.filter(e => e.timestamp > oneMinuteAgo);
    const typeCount = recentTypeEntries.reduce((sum, e) => sum + e.count, 0);
    
    if (typeCount >= limits.perTypePerMinute) {
      return true;
    }
  }

  // Check per-severity limit
  if (limits.perSeverityPerMinute) {
    const severityEntries = rateLimitState.severityCounts[severity] || [];
    const recentSeverityEntries = severityEntries.filter(e => e.timestamp > oneMinuteAgo);
    const severityCount = recentSeverityEntries.reduce((sum, e) => sum + e.count, 0);
    
    if (severityCount >= limits.perSeverityPerMinute) {
      return true;
    }
  }

  return false;
}

function recordNotification(
  type: NotificationType,
  severity: NotificationSeverity,
  dedupeKey: string
): void {
  if (!rateLimitState) return;

  const now = new Date().toISOString();

  // Update dedupe key
  rateLimitState.lastDedupeKeys[type] = dedupeKey;

  // Update type counts
  if (!rateLimitState.typeCounts[type]) {
    rateLimitState.typeCounts[type] = [];
  }
  rateLimitState.typeCounts[type].push({ timestamp: now, count: 1 });

  // Update severity counts
  if (!rateLimitState.severityCounts[severity]) {
    rateLimitState.severityCounts[severity] = [];
  }
  rateLimitState.severityCounts[severity].push({ timestamp: now, count: 1 });

  // Clean up old entries (older than 5 minutes)
  const fiveMinutesAgo = new Date(Date.now() - 300000).toISOString();
  
  for (const t of Object.keys(rateLimitState.typeCounts)) {
    rateLimitState.typeCounts[t] = rateLimitState.typeCounts[t].filter(
      e => e.timestamp > fiveMinutesAgo
    );
  }

  for (const s of Object.keys(rateLimitState.severityCounts)) {
    rateLimitState.severityCounts[s] = rateLimitState.severityCounts[s].filter(
      e => e.timestamp > fiveMinutesAgo
    );
  }

  rateLimitState.updatedAt = now;

  // Persist rate limit state (fire and forget)
  saveRateLimitState().catch(() => {
    // Ignore persistence errors
  });
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get notification statistics.
 */
export async function getNotificationStats(): Promise<{
  total: number;
  byType: Record<NotificationType, number>;
  bySeverity: Record<NotificationSeverity, number>;
  delivered: number;
  undelivered: number;
}> {
  await initNotificationManager();

  const notifications = await listNotifications({}, 10000);

  const byType: Record<NotificationType, number> = {
    dlq_overflow: 0,
    watchdog: 0,
    policy_denial: 0,
    error: 0,
    manual_escalation: 0,
    pause: 0,
    resume: 0,
  };

  const bySeverity: Record<NotificationSeverity, number> = {
    info: 0,
    warning: 0,
    critical: 0,
  };

  let delivered = 0;
  let undelivered = 0;

  for (const n of notifications) {
    byType[n.type] = (byType[n.type] || 0) + 1;
    bySeverity[n.severity] = (bySeverity[n.severity] || 0) + 1;

    if (n.delivery?.delivered) {
      delivered++;
    } else {
      undelivered++;
    }
  }

  return {
    total: notifications.length,
    byType,
    bySeverity,
    delivered,
    undelivered,
  };
}

// ============================================================================
// Internal Functions
// ============================================================================

async function saveNotification(notification: EscalationNotification): Promise<void> {
  const filePath = join(NOTIFICATIONS_DIR, `${notification.notificationId}.json`);
  await writeFile(filePath, JSON.stringify(notification, null, 2) + "\n", "utf8");
}

async function loadRateLimitState(): Promise<RateLimitState | null> {
  try {
    if (!existsSync(RATE_LIMIT_FILE)) {
      return null;
    }

    const content = await readFile(RATE_LIMIT_FILE, "utf8");
    return JSON.parse(content) as RateLimitState;
  } catch {
    return null;
  }
}

async function saveRateLimitState(): Promise<void> {
  if (!rateLimitState) return;
  await writeFile(RATE_LIMIT_FILE, JSON.stringify(rateLimitState, null, 2) + "\n", "utf8");
}

async function loadConfig(): Promise<EscalationConfig | null> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }

    const content = await readFile(CONFIG_FILE, "utf8");
    return JSON.parse(content) as EscalationConfig;
  } catch {
    return null;
  }
}

async function saveConfig(): Promise<void> {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Reset the notification manager (for testing only).
 */
export async function resetNotificationManager(): Promise<void> {
  rateLimitState = null;
  config = { ...DEFAULT_CONFIG };
  initializationPromise = null;
  
  // Clear persisted rate limit and config files
  try {
    const { unlink } = await import("node:fs/promises");
    if (existsSync(RATE_LIMIT_FILE)) {
      await unlink(RATE_LIMIT_FILE);
    }
    if (existsSync(CONFIG_FILE)) {
      await unlink(CONFIG_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Clear the notification manager cache without modifying state (for testing only).
 */
export function clearNotificationCache(): void {
  initializationPromise = null;
}
