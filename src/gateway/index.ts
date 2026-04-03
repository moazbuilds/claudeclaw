/**
 * Gateway Orchestrator — single entry point for all inbound normalized events.
 * 
 * CONTROL FLOW:
 *   Adapter -> Normalizer -> Gateway -> Event Log -> Processor
 * 
 * CRITICAL DESIGN CONSTRAINTS:
 * - Gateway is the single entry point for all inbound events
 * - Sequence numbers are assigned by the event log, NOT by getLastSeq() + 1 in gateway
 * - Gateway coordinates, it does NOT duplicate processor responsibilities
 * - Channel adapters do NOT call runner.ts directly
 * 
 * DEPENDENCY INJECTION:
 * - Uses injected dependencies via GatewayDependencies interface
 * - Falls back to module globals for backward compatibility
 */

import { append as eventLogAppend, type EventRecord, type EventEntryInput } from "../event-log";
import type { ProcessingResult } from "../event-processor";
import type { NormalizedEvent } from "./normalizer";
import {
  getOrCreateSessionMapping,
  getResumeArgsForEvent,
  updateSessionAfterProcessing,
  recordClaudeSessionId,
  type ResumeArgs,
} from "./resume";
import { shouldBlockAdmission, handlePolicyDenial } from "../escalation";
import { evaluate, type ToolRequestContext, type PolicyDecision } from "../policy/engine";
import { enqueue } from "../policy/approval-queue";
import { getGovernanceClient } from "../governance/client";

// --- Gateway Configuration ---

export interface GatewayConfig {
  /** Feature flag: enable gateway processing */
  enabled?: boolean;
  /** Fallback to legacy handler when gateway is disabled */
  useLegacyFallback?: boolean;
}

// --- Gateway Dependencies ---

export interface GatewayDependencies {
  /** Event log append function */
  eventLog: {
    append: (entry: EventEntryInput) => Promise<EventRecord>;
  };
  /** Processor function for persisted events */
  processor: {
    processPersistedEvent: (eventId: string) => Promise<ProcessorResult>;
  };
  /** Resume module functions */
  resume: {
    getOrCreateSessionMapping: typeof getOrCreateSessionMapping;
    getResumeArgsForEvent: typeof getResumeArgsForEvent;
    updateSessionAfterProcessing: typeof updateSessionAfterProcessing;
    recordClaudeSessionId?: typeof recordClaudeSessionId;
  };
}

// --- Default Dependencies (module globals) ---

// Import the event processor's gateway function
import { getGatewayProcessor } from "../event-processor";

function createDefaultDependencies(): GatewayDependencies {
  // Try to get the event processor from event-processor module
  const eventProcessorFn = getGatewayProcessor();

  return {
    eventLog: {
      append: eventLogAppend,
    },
    processor: {
      processPersistedEvent: eventProcessorFn
        ? eventProcessorFn
        : async (_eventId: string): Promise<ProcessorResult> => {
            // Default: processor not available in this context
            // Actual implementation should use initGatewayProcessor from event-processor.ts
            return { success: false, error: "Processor not configured" };
          },
    },
    resume: {
      getOrCreateSessionMapping,
      getResumeArgsForEvent,
      updateSessionAfterProcessing,
      recordClaudeSessionId,
    },
  };
}

// --- Gateway Class ---

let globalGateway: Gateway | null = null;

export class Gateway {
  private config: GatewayConfig;
  private deps: GatewayDependencies;
  private running = false;

  constructor(config: GatewayConfig = {}, deps?: GatewayDependencies) {
    this.config = config;
    this.deps = deps ?? createDefaultDependencies();
    this.running = true;
  }

  /**
   * Check if gateway is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the gateway (no-op in current implementation, reserved for future use)
   */
  async start(): Promise<void> {
    this.running = true;
    console.log("[gateway] Gateway started");
  }

  /**
   * Stop the gateway (no-op in current implementation, reserved for future use)
   */
  async stop(): Promise<void> {
    this.running = false;
    console.log("[gateway] Gateway stopped");
  }

  /**
   * Evaluate a tool request against policy rules.
   */
  private evaluatePolicy(event: NormalizedEvent, toolName: string, toolArgs?: Record<string, unknown>): PolicyDecision {
    const gc = getGovernanceClient();
    const request: ToolRequestContext = {
      eventId: event.id || crypto.randomUUID(),
      source: event.channel,
      channelId: event.channelId,
      threadId: event.threadId,
      userId: event.userId,
      toolName,
      toolArgs,
      timestamp: new Date(event.timestamp).toISOString(),
      metadata: event.metadata,
    };
    return gc.evaluateToolRequest(request);
  }

  /**
   * Check if approval is required and enqueue if so.
   * Returns true if the request was enqueued for approval.
   */
  private async checkToolApproval(
    event: NormalizedEvent, 
    decision: PolicyDecision
  ): Promise<{ needsApproval: boolean; approvalId?: string }> {
    if (decision.action !== "require_approval") {
      return { needsApproval: false };
    }
    
    const gc = getGovernanceClient();
    const request: ToolRequestContext = {
      eventId: event.id || crypto.randomUUID(),
      source: event.channel,
      channelId: event.channelId,
      threadId: event.threadId,
      userId: event.userId,
      toolName: decision.matchedRuleId || "unknown",
      timestamp: new Date(event.timestamp).toISOString(),
    };
    
    const entry = await gc.requestApproval(request, decision);
    if (entry) {
      return { needsApproval: true, approvalId: entry.id };
    }
    return { needsApproval: false };
  }

  /**
   * Process an inbound normalized event.
   * 
   * Flow:
   * 1. Validate normalized input
   * 2. Resolve or create session mapping
   * 3. Append event to event log (event log assigns sequence number)
   * 4. Trigger processor on persisted event record
   * 5. Update mapping metadata after success
   * 6. Record real Claude session ID if available
   * 
   * @param event - NormalizedEvent from adapter/normalizer
   * @returns Processing result with event record and session info
   */
  async processInboundEvent(event: NormalizedEvent): Promise<{
    success: boolean;
    eventRecord?: EventRecord;
    resumeArgs?: ResumeArgs;
    error?: string;
  }> {
    if (!this.running) {
      return { success: false, error: "Gateway is not running" };
    }

    // Step 1: Validate the normalized event
    if (!this.validateEvent(event)) {
      return { success: false, error: "Invalid normalized event" };
    }

    // Step 1b: Check if system is paused - reject new events when paused
    if (await shouldBlockAdmission()) {
      return { success: false, error: "System is paused - new events are not being admitted" };
    }

    try {
      // Step 2: Resolve or create session mapping
      const sessionEntry = await this.deps.resume.getOrCreateSessionMapping(
        event.channelId,
        event.threadId
      );

      // Step 2b: Evaluate policy for inbound event
      // This evaluates the incoming message as a "tool" request
      const policyDecision = this.evaluatePolicy(event, "InboundMessage", {
        messageLength: event.text?.length ?? 0,
        hasAttachments: (event.attachments ?? []).length > 0,
      });

      // Check if approval is required
      const { needsApproval, approvalId } = await this.checkToolApproval(event, policyDecision);
      if (needsApproval) {
        return { 
          success: false, 
          error: `Request requires approval (ID: ${approvalId}). Please wait for operator approval.`,
        };
      }

      // If denied, reject the request
      if (policyDecision.action === "deny") {
        // Trigger escalation for policy denial
        await handlePolicyDenial(event.id, "InboundMessage", policyDecision.reason || "Policy denied request", {
          severity: "warning",
          channelId: event.channelId,
          sessionId: sessionEntry.sessionId,
        });
        return { 
          success: false, 
          error: `Request denied: ${policyDecision.reason}`,
        };
      }

      // Step 3: Append event to event log (sequence number assigned by event log)
      const eventRecord = await this.deps.eventLog.append({
        type: `inbound:${event.channel}`,
        source: event.channel,
        channelId: event.channelId,
        threadId: event.threadId,
        payload: {
          normalizedEvent: event,
          sessionMappingId: sessionEntry.mappingId,
        },
        dedupeKey: event.sourceEventId 
          ? `${event.channel}:${event.sourceEventId}` 
          : `${event.channelId}:${event.threadId}:${event.timestamp}`,
        correlationId: undefined,
        causationId: undefined,
      });

      // Step 4: Trigger processor on the persisted event record
      // The processor handles the actual Claude CLI execution
      let processorResult: ProcessingResult;
      try {
        processorResult = await this.deps.processor.processPersistedEvent(eventRecord.id);
      } catch (err) {
        processorResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // Step 5: Update mapping metadata after successful processing
      if (processorResult.success) {
        await this.deps.resume.updateSessionAfterProcessing(
          event.channelId,
          event.threadId,
          eventRecord.seq,
          { turnCountIncrement: 1 }
        );
      }

      // Step 6: Record real Claude session ID if available in processor result
      // This is transitional - the processor should expose a seam for session ID extraction
      if (processorResult.success && processorResult.claudeSessionId) {
        if (this.deps.resume.recordClaudeSessionId) {
          await this.deps.resume.recordClaudeSessionId(
            event.channelId,
            event.threadId,
            processorResult.claudeSessionId
          );
        }
      }

      // Get resume args for response
      const resumeArgs = await this.deps.resume.getResumeArgsForEvent(event);

      return {
        success: processorResult.success,
        eventRecord,
        resumeArgs,
        error: processorResult.error,
      };
    } catch (err) {
      console.error("[gateway] Error processing inbound event:", err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Validate a normalized event
   */
  private validateEvent(event: NormalizedEvent): boolean {
    if (!event) return false;
    if (!event.channelId) return false;
    if (!event.threadId) return false;
    if (!event.channel) return false;
    return true;
  }
}

// --- Factory Functions ---

/**
 * Create a new Gateway instance with optional config and dependencies
 */
export function createGateway(config?: GatewayConfig, deps?: GatewayDependencies): Gateway {
  return new Gateway(config, deps);
}

/**
 * Get the global gateway instance (singleton)
 */
export function getGateway(): Gateway | null {
  return globalGateway;
}

/**
 * Set the global gateway instance
 */
export function setGateway(gateway: Gateway): void {
  globalGateway = gateway;
}

// --- Standalone Process Function ---

/**
 * Process an inbound event using the global gateway or create a new one.
 * This is the main entry point for the gateway orchestrator.
 */
export async function processInboundEvent(event: NormalizedEvent): Promise<{
  success: boolean;
  eventRecord?: EventRecord;
  resumeArgs?: ResumeArgs;
  error?: string;
}> {
  // Check if system is paused before creating gateway
  if (await shouldBlockAdmission()) {
    return { success: false, error: "System is paused - new events are not being admitted" };
  }

  // Get or create gateway
  let gateway = getGateway();
  if (!gateway) {
    // Check feature flag
    const useGateway = process.env.USE_GATEWAY === "true" || isGatewayEnabled();
    if (!useGateway) {
      return { success: false, error: "Gateway is disabled" };
    }
    gateway = createGateway();
    setGateway(gateway);
  }

  return gateway.processInboundEvent(event);
}

// --- Feature Flag ---

let cachedGatewayEnabled: boolean | null = null;

/**
 * Check if the gateway is enabled via environment variable or settings
 */
export function isGatewayEnabled(): boolean {
  if (cachedGatewayEnabled !== null) {
    return cachedGatewayEnabled;
  }

  // Check environment variable
  const envValue = process.env.USE_GATEWAY;
  if (envValue !== undefined) {
    cachedGatewayEnabled = envValue === "true";
    return cachedGatewayEnabled;
  }

  // Default to false for conservative migration
  cachedGatewayEnabled = false;
  return cachedGatewayEnabled;
}

/**
 * Clear the cached gateway enabled state (useful for testing)
 */
export function clearGatewayEnabledCache(): void {
  cachedGatewayEnabled = null;
}

/**
 * Set gateway enabled state (useful for testing)
 */
export function setGatewayEnabled(enabled: boolean): void {
  cachedGatewayEnabled = enabled;
}

// --- Extended Processor Result ---

export interface ProcessorResult extends ProcessingResult {
  /** Real Claude session ID if available (extracted from first successful run) */
  claudeSessionId?: string;
}

// Re-export ProcessingResult from event-processor for convenience
export type { ProcessingResult } from "../event-processor";

// --- Event Processing with Fallback ---

export interface ProcessEventOptions {
  /** Legacy handler to call when gateway is disabled */
  legacyHandler?: () => Promise<LegacyResult>;
  /** Options to pass to the legacy handler */
  legacyOptions?: Record<string, unknown>;
}

export interface LegacyResult {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Process an event with automatic fallback to legacy handler.
 * 
 * Migration pattern:
 * - When gateway is enabled: routes through gateway orchestrator
 * - When gateway is disabled: calls legacy handler (e.g., runUserMessage)
 * 
 * @param event - NormalizedEvent to process
 * @param options - Options including legacy handler for fallback
 * @returns Result with source information
 */
export async function processEventWithFallback(
  event: NormalizedEvent,
  options: ProcessEventOptions = {}
): Promise<{
  success: boolean;
  source: "gateway" | "legacy";
  eventRecord?: EventRecord;
  resumeArgs?: ResumeArgs;
  error?: string;
  legacyResult?: LegacyResult;
}> {
  // Check if system is paused before routing
  if (await shouldBlockAdmission()) {
    return {
      success: false,
      source: "gateway",
      error: "System is paused - new events are not being admitted",
    };
  }

  // Check if gateway is enabled
  const gatewayEnabled = isGatewayEnabled();

  if (gatewayEnabled) {
    // Use gateway path
    let gateway = getGateway();
    if (!gateway) {
      gateway = createGateway({ enabled: true });
      setGateway(gateway);
    }

    const result = await gateway.processInboundEvent(event);
    return {
      success: result.success,
      source: "gateway",
      eventRecord: result.eventRecord,
      resumeArgs: result.resumeArgs,
      error: result.error,
    };
  } else {
    // Use legacy path
    if (options.legacyHandler) {
      try {
        const legacyResult = await options.legacyHandler();
        return {
          success: legacyResult.exitCode === 0,
          source: "legacy",
          error: legacyResult.error ?? legacyResult.stderr ?? undefined,
          legacyResult,
        };
      } catch (err) {
        return {
          success: false,
          source: "legacy",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // No legacy handler available
    return {
      success: false,
      source: "legacy",
      error: "Gateway disabled and no legacy handler provided",
    };
  }
}

// --- Adapter Helpers ---

/**
 * Normalize and process a Telegram message through the gateway.
 * 
 * Usage in telegram.ts migration:
 *   // Before (legacy):
 *   const result = await runUserMessage("telegram", prompt);
 *   
 *   // After (with gateway):
 *   const normalized = normalizeTelegramMessage(message);
 *   const result = await submitTelegramToGateway(normalized);
 */
export async function submitTelegramToGateway(
  message: import("./normalizer").TelegramMessage
): Promise<{
  success: boolean;
  source: "gateway" | "legacy";
  error?: string;
}> {
  const { normalizeTelegramMessage } = await import("./normalizer");
  const normalized = normalizeTelegramMessage(message);

  const result = await processEventWithFallback(normalized, {
    legacyHandler: async () => {
      // Legacy handler is not called from here - adapters should
      // pass their own legacy handler if they want fallback
      return { success: false, error: "Legacy fallback not configured" };
    },
  });

  return {
    success: result.success,
    source: result.source,
    error: result.error,
  };
}

/**
 * Normalize and process a Discord message through the gateway.
 * 
 * Usage in discord.ts migration:
 *   // Before (legacy):
 *   const result = await runUserMessage("discord", prompt);
 *   
 *   // After (with gateway):
 *   const normalized = normalizeDiscordMessage(message);
 *   const result = await submitDiscordToGateway(normalized);
 */
export async function submitDiscordToGateway(
  message: import("./normalizer").DiscordMessage
): Promise<{
  success: boolean;
  source: "gateway" | "legacy";
  error?: string;
}> {
  const { normalizeDiscordMessage } = await import("./normalizer");
  const normalized = normalizeDiscordMessage(message);

  const result = await processEventWithFallback(normalized, {
    legacyHandler: async () => {
      // Legacy handler is not called from here - adapters should
      // pass their own legacy handler if they want fallback
      return { success: false, error: "Legacy fallback not configured" };
    },
  });

  return {
    success: result.success,
    source: result.source,
    error: result.error,
  };
}
