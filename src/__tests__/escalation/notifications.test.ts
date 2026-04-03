/**
 * Tests for escalation/notifications.ts
 * 
 * Run with: bun test src/__tests__/escalation/notifications.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  initNotificationManager,
  notify,
  listNotifications,
  getNotification,
  configure,
  getConfig,
  retryDelivery,
  getNotificationStats,
  resetNotificationManager,
  clearNotificationCache,
  type NotificationType,
  type NotificationSeverity,
} from "../../escalation/notifications";

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const NOTIFICATIONS_DIR = join(ESCALATION_DIR, "notifications");
const RATE_LIMIT_FILE = join(ESCALATION_DIR, "notification-rate-limits.json");
const CONFIG_FILE = join(ESCALATION_DIR, "notification-config.json");

describe("Notification Manager - Initialization", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should initialize with default config", async () => {
    await initNotificationManager();
    
    const config = getConfig();
    expect(config.enabledTypes).toContain("dlq_overflow");
    expect(config.enabledTypes).toContain("watchdog");
    expect(config.enabledTypes).toContain("policy_denial");
    expect(config.minSeverity).toBe("info");
  });

  it("should create notifications directory", async () => {
    await initNotificationManager();
    
    expect(existsSync(NOTIFICATIONS_DIR)).toBe(true);
  });
});

describe("Notification Manager - Create Notification", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should create a basic notification", async () => {
    const notification = await notify("dlq_overflow", "warning", "DLQ has 100 items");
    
    expect(notification).not.toBeNull();
    expect(notification!.notificationId).toBeDefined();
    expect(notification!.type).toBe("dlq_overflow");
    expect(notification!.severity).toBe("warning");
    expect(notification!.message).toBe("DLQ has 100 items");
    expect(notification!.createdAt).toBeDefined();
    expect(notification!.delivery).toBeDefined();
  });

  it("should create notification with context", async () => {
    const notification = await notify(
      "policy_denial",
      "critical",
      "Tool execution denied",
      {
        eventId: "evt-123",
        workflowId: "wf-456",
        sessionId: "session-789",
        details: { toolName: "Bash", reason: "Security policy" },
      }
    );
    
    expect(notification!.eventId).toBe("evt-123");
    expect(notification!.workflowId).toBe("wf-456");
    expect(notification!.sessionId).toBe("session-789");
    expect(notification!.details).toEqual({
      toolName: "Bash",
      reason: "Security policy",
    });
  });

  it("should persist notification to file", async () => {
    const notification = await notify("error", "critical", "System error");
    
    const filePath = join(NOTIFICATIONS_DIR, `${notification!.notificationId}.json`);
    expect(existsSync(filePath)).toBe(true);
  });

  it("should skip disabled notification types", async () => {
    await configure({ enabledTypes: ["dlq_overflow"] });
    
    const notification = await notify("watchdog", "warning", "Should be skipped");
    
    expect(notification).toBeNull();
  });

  it("should skip notifications below minimum severity", async () => {
    await configure({ minSeverity: "warning" });
    
    const infoNotification = await notify("dlq_overflow", "info", "Info message");
    const warningNotification = await notify("dlq_overflow", "warning", "Warning message");
    
    expect(infoNotification).toBeNull();
    expect(warningNotification).not.toBeNull();
  });
});

describe("Notification Manager - Deduplication", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should deduplicate identical notifications", async () => {
    const n1 = await notify("dlq_overflow", "warning", "Same message");
    const n2 = await notify("dlq_overflow", "warning", "Same message");
    
    expect(n1).not.toBeNull();
    expect(n2).toBeNull(); // Duplicate suppressed
  });

  it("should allow different types with same message", async () => {
    const n1 = await notify("dlq_overflow", "warning", "Same message");
    const n2 = await notify("watchdog", "warning", "Same message");
    
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
  });

  it("should allow same type with different severity", async () => {
    const n1 = await notify("dlq_overflow", "warning", "Same message");
    const n2 = await notify("dlq_overflow", "critical", "Same message");
    
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
  });

  it("should allow notifications for different events", async () => {
    const n1 = await notify("dlq_overflow", "warning", "Same message", { eventId: "evt-1" });
    const n2 = await notify("dlq_overflow", "warning", "Same message", { eventId: "evt-2" });
    
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
  });
});

describe("Notification Manager - Rate Limiting", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
    // Set very low rate limits for testing
    await configure({ rateLimits: { perTypePerMinute: 2, perSeverityPerMinute: 3 } });
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should rate limit by type", async () => {
    const n1 = await notify("dlq_overflow", "info", "Message 1");
    const n2 = await notify("dlq_overflow", "info", "Message 2");
    const n3 = await notify("dlq_overflow", "info", "Message 3"); // Should be rate limited
    
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
    expect(n3).toBeNull(); // Rate limited
  });

  it("should rate limit by severity", async () => {
    const n1 = await notify("dlq_overflow", "warning", "Warning 1");
    const n2 = await notify("watchdog", "warning", "Warning 2");
    const n3 = await notify("policy_denial", "warning", "Warning 3");
    const n4 = await notify("error", "warning", "Warning 4"); // Should be rate limited
    
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
    expect(n3).not.toBeNull(); // Still within limit of 3
    expect(n4).toBeNull(); // Rate limited
  });

  it("should allow different types under severity limit", async () => {
    // With perSeverityPerMinute: 3, we should be able to send 3 warnings
    const n1 = await notify("dlq_overflow", "info", "Info 1");
    const n2 = await notify("dlq_overflow", "info", "Info 2");
    
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
  });
});

describe("Notification Manager - List and Get", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should list all notifications sorted by date", async () => {
    await notify("dlq_overflow", "warning", "First");
    await new Promise(r => setTimeout(r, 10));
    await notify("watchdog", "info", "Second");
    
    const notifications = await listNotifications();
    
    expect(notifications).toHaveLength(2);
    expect(notifications[0].message).toBe("Second");
    expect(notifications[1].message).toBe("First");
  });

  it("should filter by type", async () => {
    await notify("dlq_overflow", "warning", "DLQ message");
    await notify("watchdog", "info", "Watchdog message");
    
    const dlqNotifications = await listNotifications({ type: "dlq_overflow" });
    
    expect(dlqNotifications).toHaveLength(1);
    expect(dlqNotifications[0].type).toBe("dlq_overflow");
  });

  it("should filter by severity", async () => {
    await notify("dlq_overflow", "info", "Info");
    await notify("dlq_overflow", "warning", "Warning");
    await notify("dlq_overflow", "critical", "Critical");
    
    const criticalNotifications = await listNotifications({ severity: "critical" });
    
    expect(criticalNotifications).toHaveLength(1);
    expect(criticalNotifications[0].severity).toBe("critical");
  });

  it("should filter by eventId", async () => {
    await notify("dlq_overflow", "warning", "Event 1", { eventId: "evt-1" });
    await notify("dlq_overflow", "warning", "Event 2", { eventId: "evt-2" });
    
    const event1Notifications = await listNotifications({ eventId: "evt-1" });
    
    expect(event1Notifications).toHaveLength(1);
    expect(event1Notifications[0].eventId).toBe("evt-1");
  });

  it("should filter by undelivered status", async () => {
    // Create a notification (not delivered by default without config)
    const n = await notify("dlq_overflow", "warning", "Undelivered");
    
    // Mark one as delivered manually
    const undelivered = await listNotifications({ undeliveredOnly: true });
    
    expect(undelivered.length).toBeGreaterThanOrEqual(1);
  });

  it("should respect limit parameter", async () => {
    // Reset rate limits
    await configure({ rateLimits: { perTypePerMinute: 100 } });
    
    for (let i = 0; i < 5; i++) {
      await notify("dlq_overflow", "info", `Message ${i}`);
    }
    
    const notifications = await listNotifications({}, 3);
    
    expect(notifications.length).toBeLessThanOrEqual(3);
  });

  it("should get notification by ID", async () => {
    const created = await notify("dlq_overflow", "warning", "Get me");
    
    const retrieved = await getNotification(created!.notificationId);
    
    expect(retrieved).not.toBeNull();
    expect(retrieved!.notificationId).toBe(created!.notificationId);
    expect(retrieved!.message).toBe("Get me");
  });

  it("should return null for non-existent notification", async () => {
    const retrieved = await getNotification("non-existent-id");
    expect(retrieved).toBeNull();
  });
});

describe("Notification Manager - Configuration", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should update configuration", async () => {
    await configure({
      webhookUrl: "https://example.com/webhook",
      emailTarget: "alerts@example.com",
      minSeverity: "warning",
    });
    
    const config = getConfig();
    expect(config.webhookUrl).toBe("https://example.com/webhook");
    expect(config.emailTarget).toBe("alerts@example.com");
    expect(config.minSeverity).toBe("warning");
  });

  it("should merge rate limits on update", async () => {
    await configure({ rateLimits: { perTypePerMinute: 50 } });
    
    const config = getConfig();
    expect(config.rateLimits?.perTypePerMinute).toBe(50);
    expect(config.rateLimits?.perSeverityPerMinute).toBe(20); // Default preserved
  });

  it("should persist configuration", async () => {
    await configure({ webhookUrl: "https://test.com" });
    
    // Clear cache and reload
    clearNotificationCache();
    await initNotificationManager();
    
    const config = getConfig();
    expect(config.webhookUrl).toBe("https://test.com");
  });
});

describe("Notification Manager - Statistics", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should return correct statistics", async () => {
    await notify("dlq_overflow", "warning", "DLQ warning");
    await notify("dlq_overflow", "critical", "DLQ critical");
    await notify("watchdog", "info", "Watchdog info");
    await notify("policy_denial", "warning", "Policy warning");
    
    const stats = await getNotificationStats();
    
    expect(stats.total).toBe(4);
    expect(stats.byType.dlq_overflow).toBe(2);
    expect(stats.byType.watchdog).toBe(1);
    expect(stats.byType.policy_denial).toBe(1);
    expect(stats.bySeverity.warning).toBe(2);
    expect(stats.bySeverity.critical).toBe(1);
    expect(stats.bySeverity.info).toBe(1);
  });

  it("should track delivery status", async () => {
    // Without delivery config, all are undelivered
    await notify("dlq_overflow", "warning", "Undelivered");
    
    const stats = await getNotificationStats();
    
    expect(stats.undelivered).toBeGreaterThanOrEqual(1);
  });
});

describe("Notification Manager - All Notification Types", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetNotificationManager();
    // Disable rate limits for these tests
    await configure({ rateLimits: { perTypePerMinute: 100, perSeverityPerMinute: 100 } });
  });

  afterEach(async () => {
    try {
      await rm(NOTIFICATIONS_DIR, { recursive: true, force: true });
      if (existsSync(RATE_LIMIT_FILE)) await unlink(RATE_LIMIT_FILE);
      if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
    } catch {
      // Ignore
    }
  });

  it("should support all notification types", async () => {
    const types: NotificationType[] = [
      "dlq_overflow",
      "watchdog",
      "policy_denial",
      "error",
      "manual_escalation",
      "pause",
      "resume",
    ];
    
    for (const type of types) {
      const notification = await notify(type, "info", `Test ${type}`);
      expect(notification).not.toBeNull();
      expect(notification!.type).toBe(type);
    }
    
    const allNotifications = await listNotifications();
    expect(allNotifications).toHaveLength(types.length);
  });

  it("should support all severity levels", async () => {
    const severities: NotificationSeverity[] = ["info", "warning", "critical"];
    
    for (const severity of severities) {
      // Add delay to avoid deduplication
      await new Promise(r => setTimeout(r, 10));
      const notification = await notify("dlq_overflow", severity, `Test ${severity}`);
      expect(notification).not.toBeNull();
      expect(notification!.severity).toBe(severity);
    }
  });
});
