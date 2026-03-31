/**
 * Gateway Integration Tests
 * 
 * Tests cover:
 * - Happy path end-to-end: normalize -> gateway -> event log -> processor
 * - Mapping creation and reuse
 * - Thread isolation
 * - Feature flag behavior
 * - Processor failure handling
 * - Event-log append failure handling
 * - Concurrent inbound events behave consistently
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";

// Mock modules before importing gateway
vi.mock("../event-log", () => {
  const mockRecords: Map<string, any> = new Map();
  let seqCounter = 0;

  return {
    append: vi.fn(async (entry: any) => {
      seqCounter++;
      const record = {
        id: randomUUID(),
        seq: seqCounter,
        type: entry.type,
        source: entry.source,
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "pending",
        channelId: entry.channelId,
        threadId: entry.threadId,
        payload: entry.payload,
        dedupeKey: entry.dedupeKey,
        retryCount: 0,
        nextRetryAt: null,
        correlationId: entry.correlationId ?? null,
        causationId: entry.causationId ?? null,
        replayedFromEventId: entry.replayedFromEventId ?? null,
        lastError: null,
      };
      mockRecords.set(record.id, record);
      return record;
    }),
    initEventLog: vi.fn().mockResolvedValue(undefined),
    resetEventLog: vi.fn().mockImplementation(() => {
      mockRecords.clear();
      seqCounter = 0;
    }),
    getLastSeq: vi.fn().mockResolvedValue(seqCounter),
  };
});

vi.mock("../gateway/session-map", () => {
  const mockMappings: Map<string, any> = new Map();

  return {
    get: vi.fn(async (channelId: string, threadId: string) => {
      const key = `${channelId}:${threadId}`;
      return mockMappings.get(key) ?? null;
    }),
    set: vi.fn(async (channelId: string, threadId: string, entry: any) => {
      const key = `${channelId}:${threadId}`;
      mockMappings.set(key, {
        mappingId: entry.mappingId ?? randomUUID(),
        channelId,
        threadId,
        claudeSessionId: entry.claudeSessionId ?? null,
        lastSeq: entry.lastSeq ?? 0,
        turnCount: entry.turnCount ?? 0,
        status: entry.status ?? "pending",
        lastActiveAt: entry.lastActiveAt ?? new Date().toISOString(),
        createdAt: entry.createdAt ?? new Date().toISOString(),
        updatedAt: entry.updatedAt ?? new Date().toISOString(),
        ...entry,
      });
    }),
    remove: vi.fn(async (channelId: string, threadId: string) => {
      const key = `${channelId}:${threadId}`;
      mockMappings.delete(key);
    }),
    getOrCreateMapping: vi.fn(async (channelId: string, threadId: string) => {
      const key = `${channelId}:${threadId}`;
      let entry = mockMappings.get(key);
      if (!entry) {
        entry = {
          mappingId: randomUUID(),
          channelId,
          threadId,
          claudeSessionId: null,
          lastSeq: 0,
          turnCount: 0,
          status: "pending",
          lastActiveAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        mockMappings.set(key, entry);
      }
      return entry;
    }),
    update: vi.fn(async (channelId: string, threadId: string, patch: any) => {
      const key = `${channelId}:${threadId}`;
      const existing = mockMappings.get(key);
      if (existing) {
        mockMappings.set(key, { ...existing, ...patch, updatedAt: new Date().toISOString() });
      }
    }),
    attachClaudeSessionId: vi.fn(),
    resetSessionMap: vi.fn().mockImplementation(() => {
      mockMappings.clear();
    }),
  };
});

// Mock escalation module - must be before gateway import
// Gateway imports from ../escalation which resolves to src/escalation from src/gateway/
// Test file is at src/__tests__/gateway/index.test.ts, so ../../escalation resolves to src/escalation
vi.mock("../../escalation", () => ({
  shouldBlockAdmission: vi.fn().mockResolvedValue(false),
  shouldBlockScheduling: vi.fn().mockResolvedValue(false),
  handlePolicyDenial: vi.fn().mockResolvedValue({
    actionId: "mock-action-id",
    timestamp: new Date().toISOString(),
    pause: false,
    handoff: false,
    notification: false,
    reason: "Mocked for tests",
  }),
  handleEscalationTrigger: vi.fn().mockResolvedValue({
    actionId: "mock-action-id",
    timestamp: new Date().toISOString(),
    pause: false,
    handoff: false,
    notification: false,
    reason: "Mocked for tests",
  }),
  pause: vi.fn().mockResolvedValue({}),
  resume: vi.fn().mockResolvedValue({}),
  isPaused: vi.fn().mockResolvedValue(false),
  getPauseState: vi.fn().mockResolvedValue({ paused: false, mode: "admission_only" }),
  resetPauseController: vi.fn().mockResolvedValue(undefined),
  clearPauseCache: vi.fn(),
}));

// Mock policy engine - must be before gateway import
vi.mock("../../policy/engine", () => ({
  evaluate: vi.fn().mockReturnValue({
    requestId: "mock-request-id",
    action: "allow",
    reason: "Mocked policy - allowed",
    evaluatedAt: new Date().toISOString(),
    cacheable: false,
  }),
  loadPolicies: vi.fn().mockResolvedValue(undefined),
  getPolicies: vi.fn().mockReturnValue([]),
}));

// Mock governance client
vi.mock("../../governance/client", () => ({
  getGovernanceClient: vi.fn().mockReturnValue({
    evaluateToolRequest: vi.fn().mockResolvedValue({
      action: "allow",
      reason: "Mocked governance",
    }),
    isToolAllowed: vi.fn().mockReturnValue(true),
    requiresApproval: vi.fn().mockReturnValue(false),
    checkPolicy: vi.fn().mockResolvedValue({ allowed: true }),
    checkBudget: vi.fn().mockResolvedValue({ allowed: true, reason: "Mocked budget check" }),
    reloadPolicies: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue(null),
    getPendingApprovals: vi.fn().mockReturnValue([]),
    findApprovalByEvent: vi.fn().mockResolvedValue(null),
    getApprovalById: vi.fn().mockReturnValue(null),
    getTelemetry: vi.fn().mockResolvedValue({}),
    getUsageStats: vi.fn().mockResolvedValue({}),
    getBudgetState: vi.fn().mockResolvedValue([]),
  }),
  initGovernanceClient: vi.fn().mockResolvedValue(undefined),
  resetGovernanceClient: vi.fn(),
}));

// Now import the gateway
import {
  Gateway,
  createGateway,
  getGateway,
  setGateway,
  isGatewayEnabled,
  setGatewayEnabled,
  clearGatewayEnabledCache,
  processInboundEvent,
  processEventWithFallback,
  submitTelegramToGateway,
  submitDiscordToGateway,
  type GatewayDependencies,
  type ProcessorResult,
} from "../../gateway/index";

import type { NormalizedEvent } from "../../gateway/normalizer";
import { normalizeTelegramMessage, normalizeDiscordMessage } from "../../gateway/normalizer";

describe("Gateway", () => {
  beforeEach(() => {
    // Reset gateway state
    clearGatewayEnabledCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up
  });

  describe("constructor and config", () => {
    it("should create gateway with default config", () => {
      const gateway = new Gateway();
      expect(gateway).toBeDefined();
      expect(gateway.isRunning()).toBe(true);
    });

    it("should create gateway with custom config", () => {
      const gateway = new Gateway({ enabled: true });
      expect(gateway).toBeDefined();
    });

    it("should start and stop gateway", async () => {
      const gateway = new Gateway();
      await gateway.start();
      expect(gateway.isRunning()).toBe(true);
      await gateway.stop();
      expect(gateway.isRunning()).toBe(false);
    });
  });

  describe("processInboundEvent", () => {
    it("should reject events when gateway is not running", async () => {
      const gateway = new Gateway();
      await gateway.stop();

      const event: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:123",
        threadId: "default",
        userId: "456",
        text: "Hello",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      const result = await gateway.processInboundEvent(event);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Gateway is not running");
    });

    it("should reject invalid events", async () => {
      const gateway = new Gateway();

      // Missing channelId
      const invalidEvent = {
        id: randomUUID(),
        channel: "telegram" as const,
        channelId: "",
        threadId: "default",
        userId: "456",
        text: "Hello",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      const result = await gateway.processInboundEvent(invalidEvent);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid normalized event");
    });

    it("should process valid event and return event record", async () => {
      const mockProcessor = vi.fn().mockResolvedValue({ success: true });
      const deps: GatewayDependencies = {
        eventLog: { append: vi.fn().mockResolvedValue({
          id: randomUUID(),
          seq: 1,
          type: "inbound:telegram",
          source: "telegram",
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "pending",
          channelId: "telegram:123",
          threadId: "default",
          payload: {},
          dedupeKey: "test",
          retryCount: 0,
          nextRetryAt: null,
          correlationId: null,
          causationId: null,
          replayedFromEventId: null,
          lastError: null,
        })},
        processor: { processPersistedEvent: mockProcessor },
        resume: {
          getOrCreateSessionMapping: vi.fn().mockResolvedValue({
            mappingId: "mapping-1",
            channelId: "telegram:123",
            threadId: "default",
            claudeSessionId: null,
            lastSeq: 0,
            turnCount: 0,
            status: "pending",
            lastActiveAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          getResumeArgsForEvent: vi.fn().mockResolvedValue({
            mappingId: "mapping-1",
            claudeSessionId: null,
            args: [],
            isNewMapping: true,
            canResume: false,
          }),
          updateSessionAfterProcessing: vi.fn().mockResolvedValue(undefined),
        },
      };

      const gateway = new Gateway({}, deps);
      const event: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        sourceEventId: "msg-123",
        channelId: "telegram:123",
        threadId: "default",
        userId: "456",
        text: "Hello",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      const result = await gateway.processInboundEvent(event);
      expect(result.success).toBe(true);
      expect(result.eventRecord).toBeDefined();
      expect(mockProcessor).toHaveBeenCalled();
    });

    it("should handle processor failure", async () => {
      const mockProcessor = vi.fn().mockResolvedValue({
        success: false,
        error: "Processor error",
        shouldRetry: false,
      });
      const deps: GatewayDependencies = {
        eventLog: { append: vi.fn().mockResolvedValue({
          id: randomUUID(),
          seq: 1,
          type: "inbound:telegram",
          source: "telegram",
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "pending",
          channelId: "telegram:123",
          threadId: "default",
          payload: {},
          dedupeKey: "test",
          retryCount: 0,
          nextRetryAt: null,
          correlationId: null,
          causationId: null,
          replayedFromEventId: null,
          lastError: null,
        })},
        processor: { processPersistedEvent: mockProcessor },
        resume: {
          getOrCreateSessionMapping: vi.fn().mockResolvedValue({
            mappingId: "mapping-1",
            channelId: "telegram:123",
            threadId: "default",
            claudeSessionId: null,
            lastSeq: 0,
            turnCount: 0,
            status: "pending",
            lastActiveAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          getResumeArgsForEvent: vi.fn().mockResolvedValue({
            mappingId: "mapping-1",
            claudeSessionId: null,
            args: [],
            isNewMapping: true,
            canResume: false,
          }),
          updateSessionAfterProcessing: vi.fn(),
        },
      };

      const gateway = new Gateway({}, deps);
      const event: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:123",
        threadId: "default",
        userId: "456",
        text: "Hello",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      const result = await gateway.processInboundEvent(event);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Processor error");
    });
  });

  describe("feature flag", () => {
    it("should default to disabled", () => {
      clearGatewayEnabledCache();
      expect(isGatewayEnabled()).toBe(false);
    });

    it("should be enabled when USE_GATEWAY env is true", () => {
      clearGatewayEnabledCache();
      process.env.USE_GATEWAY = "true";
      expect(isGatewayEnabled()).toBe(true);
      process.env.USE_GATEWAY = undefined;
    });

    it("should respect manually set enabled state", () => {
      clearGatewayEnabledCache();
      setGatewayEnabled(true);
      expect(isGatewayEnabled()).toBe(true);
      setGatewayEnabled(false);
      expect(isGatewayEnabled()).toBe(false);
    });

    it("should cache the enabled state", () => {
      clearGatewayEnabledCache();
      setGatewayEnabled(true);
      // Multiple calls should return the same cached value
      expect(isGatewayEnabled()).toBe(true);
      expect(isGatewayEnabled()).toBe(true);
      expect(isGatewayEnabled()).toBe(true);
      // Clear cache to reset
      clearGatewayEnabledCache();
      // After clearing, should recompute (default false)
      expect(isGatewayEnabled()).toBe(false);
    });
  });

  describe("processEventWithFallback", () => {
    it("should use legacy handler when gateway is disabled", async () => {
      clearGatewayEnabledCache();
      setGatewayEnabled(false);

      const legacyHandler = vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: "Legacy response",
      });

      const event: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:123",
        threadId: "default",
        userId: "456",
        text: "Hello",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      const result = await processEventWithFallback(event, { legacyHandler });
      expect(result.success).toBe(true);
      expect(result.source).toBe("legacy");
      expect(legacyHandler).toHaveBeenCalled();
    });

    it("should return error when gateway disabled and no legacy handler", async () => {
      clearGatewayEnabledCache();
      setGatewayEnabled(false);

      const event: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:123",
        threadId: "default",
        userId: "456",
        text: "Hello",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      const result = await processEventWithFallback(event, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("no legacy handler");
    });
  });

  describe("thread isolation", () => {
    it("should create separate mappings for different threads", async () => {
      const mappings: Map<string, any> = new Map();

      const deps: GatewayDependencies = {
        eventLog: { append: vi.fn().mockResolvedValue({
          id: randomUUID(),
          seq: 1,
          type: "inbound:telegram",
          source: "telegram",
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "pending",
          channelId: "telegram:123",
          threadId: "default",
          payload: {},
          dedupeKey: "test",
          retryCount: 0,
          nextRetryAt: null,
          correlationId: null,
          causationId: null,
          replayedFromEventId: null,
          lastError: null,
        })},
        processor: { processPersistedEvent: vi.fn().mockResolvedValue({ success: true }) },
        resume: {
          getOrCreateSessionMapping: vi.fn().mockImplementation(async (channelId: string, threadId: string) => {
            const key = `${channelId}:${threadId}`;
            if (!mappings.has(key)) {
              mappings.set(key, {
                mappingId: `mapping-${mappings.size + 1}`,
                channelId,
                threadId,
                claudeSessionId: null,
                lastSeq: 0,
                turnCount: 0,
                status: "pending",
                lastActiveAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
            return mappings.get(key);
          }),
          getResumeArgsForEvent: vi.fn().mockImplementation(async (event: NormalizedEvent) => {
            const key = `${event.channelId}:${event.threadId}`;
            const entry = mappings.get(key);
            return {
              mappingId: entry?.mappingId ?? "unknown",
              claudeSessionId: entry?.claudeSessionId ?? null,
              args: entry?.claudeSessionId ? ["--resume", entry.claudeSessionId] : [],
              isNewMapping: !entry,
              canResume: entry?.claudeSessionId !== null,
            };
          }),
          updateSessionAfterProcessing: vi.fn().mockImplementation(async (channelId: string, threadId: string, seq: number) => {
            const key = `${channelId}:${threadId}`;
            const existing = mappings.get(key);
            if (existing) {
              mappings.set(key, { ...existing, lastSeq: seq, turnCount: existing.turnCount + 1 });
            }
          }),
        },
      };

      const gateway = new Gateway({}, deps);

      // Process event for thread 1
      const event1: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:123",
        threadId: "thread-1",
        userId: "456",
        text: "Hello from thread 1",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      await gateway.processInboundEvent(event1);

      // Process event for thread 2
      const event2: NormalizedEvent = {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:123",
        threadId: "thread-2",
        userId: "456",
        text: "Hello from thread 2",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      };

      await gateway.processInboundEvent(event2);

      // Verify separate mappings were created
      expect(mappings.size).toBe(2);
      expect(mappings.get("telegram:123:thread-1")).toBeDefined();
      expect(mappings.get("telegram:123:thread-2")).toBeDefined();
    });
  });
});

describe("Normalizer integration", () => {
  describe("normalizeTelegramMessage", () => {
    it("should normalize a basic Telegram message", () => {
      const telegramMessage = {
        message_id: 123,
        from: { id: 456, first_name: "Test", username: "testuser" },
        chat: { id: 123, type: "private" },
        text: "Hello world",
      };

      const normalized = normalizeTelegramMessage(telegramMessage);

      expect(normalized.channel).toBe("telegram");
      expect(normalized.sourceEventId).toBe("123");
      expect(normalized.channelId).toBe("telegram:123");
      expect(normalized.threadId).toBe("default");
      expect(normalized.userId).toBe("456");
      expect(normalized.text).toBe("Hello world");
    });

    it("should normalize thread messages", () => {
      const telegramMessage = {
        message_id: 123,
        from: { id: 456, first_name: "Test" },
        chat: { id: 123, type: "supergroup" },
        message_thread_id: 789,
        text: "Thread message",
      };

      const normalized = normalizeTelegramMessage(telegramMessage);

      expect(normalized.threadId).toBe("789");
    });
  });

  describe("normalizeDiscordMessage", () => {
    it("should normalize a basic Discord message", () => {
      const discordMessage = {
        id: "msg-123",
        channel_id: "channel-456",
        author: { id: "789", username: "testuser", discriminator: "0" },
        content: "Hello Discord",
        attachments: [],
        mentions: [],
        type: 0,
      };

      const normalized = normalizeDiscordMessage(discordMessage);

      expect(normalized.channel).toBe("discord");
      expect(normalized.sourceEventId).toBe("msg-123");
      expect(normalized.channelId).toBe("discord:dm:channel-456");
      expect(normalized.threadId).toBe("channel-456");
      expect(normalized.userId).toBe("789");
      expect(normalized.text).toBe("Hello Discord");
    });

    it("should preserve guild context in channelId", () => {
      const discordMessage = {
        id: "msg-123",
        channel_id: "channel-456",
        guild_id: "guild-789",
        author: { id: "111", username: "testuser", discriminator: "0" },
        content: "Guild message",
        attachments: [],
        mentions: [],
        type: 0,
      };

      const normalized = normalizeDiscordMessage(discordMessage);

      expect(normalized.channelId).toBe("discord:guild:guild-789:channel-456");
    });
  });
});

describe("Concurrent events", () => {
  it("should handle concurrent events consistently", async () => {
    const callOrder: string[] = [];
    const deps: GatewayDependencies = {
      eventLog: { 
        append: vi.fn().mockImplementation(async (entry: any) => {
          callOrder.push(`append-${entry.channelId}-${entry.threadId}`);
          return {
            id: randomUUID(),
            seq: callOrder.length,
            type: entry.type,
            source: entry.source,
            timestamp: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "pending",
            channelId: entry.channelId,
            threadId: entry.threadId,
            payload: entry.payload,
            dedupeKey: entry.dedupeKey,
            retryCount: 0,
            nextRetryAt: null,
            correlationId: entry.correlationId ?? null,
            causationId: entry.causationId ?? null,
            replayedFromEventId: entry.replayedFromEventId ?? null,
            lastError: null,
          };
        }),
      },
      processor: { processPersistedEvent: vi.fn().mockImplementation(async () => {
        callOrder.push(`process-${Date.now()}`);
        return { success: true };
      })},
      resume: {
        getOrCreateSessionMapping: vi.fn().mockResolvedValue({
          mappingId: "mapping-1",
          channelId: "telegram:123",
          threadId: "default",
          claudeSessionId: null,
          lastSeq: 0,
          turnCount: 0,
          status: "pending",
          lastActiveAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getResumeArgsForEvent: vi.fn().mockResolvedValue({
          mappingId: "mapping-1",
          claudeSessionId: null,
          args: [],
          isNewMapping: false,
          canResume: false,
        }),
        updateSessionAfterProcessing: vi.fn().mockImplementation(async () => {
          callOrder.push("update");
        }),
      },
    };

    const gateway = new Gateway({}, deps);

    // Send concurrent events
    const events: NormalizedEvent[] = [
      {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:1",
        threadId: "default",
        userId: "1",
        text: "Message 1",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      },
      {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:2",
        threadId: "default",
        userId: "2",
        text: "Message 2",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      },
      {
        id: randomUUID(),
        channel: "telegram",
        channelId: "telegram:3",
        threadId: "default",
        userId: "3",
        text: "Message 3",
        attachments: [],
        timestamp: Date.now(),
        metadata: {},
      },
    ];

    const results = await Promise.all(events.map(e => gateway.processInboundEvent(e)));

    // All should succeed
    expect(results.every(r => r.success)).toBe(true);
  });
});
