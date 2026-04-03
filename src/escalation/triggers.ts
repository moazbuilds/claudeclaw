/**
 * Escalation Trigger Integration
 * 
 * Connect existing control-plane triggers to escalation actions consistently.
 * 
 * DESIGN:
 * - Integrates with policy denials, watchdog triggers, DLQ thresholds, orchestration failures
 * - Determines when to pause, create handoffs, or send notifications
 * - Policy-driven escalation decisions
 * - All actions are explicit and auditable
 * 
 * INTEGRATION POINTS:
 * - Phase 3 Policy Engine: policy denials, approval timeouts
 * - Phase 4 Governance: watchdog triggers, budget blocks
 * - Phase 1 Event Bus: DLQ threshold crossings
 * - Phase 5 Orchestration: workflow failures
 */

import { randomUUID } from "node:crypto";
import { log as logAudit } from "../policy/audit-log";
import { notify, type NotificationType, type NotificationSeverity } from "./notifications";
import { pause, type PauseMode, shouldBlockAdmission } from "./pause";
import { createHandoff, type HandoffContext, type HandoffSeverity } from "./handoff";
import type { WatchdogDecision } from "../governance/watchdog";

// ============================================================================
// Types
// ============================================================================

export type TriggerSource = 
  | "policy_denial"
  | "policy_approval_timeout"
  | "watchdog"
  | "dlq_overflow"
  | "orchestration_failure"
  | "manual_escalation";

export interface TriggerContext {
  source: TriggerSource;
  eventId?: string;
  workflowId?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  channelId?: string;
  threadId?: string;
  sourceChannel?: string;
  message?: string;
  severity?: "info" | "warning" | "critical";
  details?: Record<string, unknown>;
  watchdogDecision?: WatchdogDecision;
}

export interface EscalationAction {
  actionId: string;
  timestamp: string;
  pause?: boolean;
  pauseMode?: PauseMode;
  handoff?: boolean;
  notification?: boolean;
  notificationType?: NotificationType;
  reason: string;
}

export interface EscalationPolicy {
  // Pause thresholds
  pauseOnCriticalPolicyDenial: boolean;
  pauseOnWatchdogSuspend: boolean;
  pauseOnDlqOverflow: boolean;
  pauseOnRepeatedOrchestrationFailures: boolean;
  
  // Handoff thresholds
  createHandoffOnPolicyDenial: boolean;
  createHandoffOnWatchdogTrigger: boolean;
  createHandoffOnManualEscalation: boolean;
  
  // Notification settings
  notifyOnPolicyDenial: boolean;
  notifyOnWatchdog: boolean;
  notifyOnDlqOverflow: boolean;
  notifyOnOrchestrationFailure: boolean;
  notifyOnPauseResume: boolean;
  
  // Minimum severity for handoff
  minHandoffSeverity: HandoffSeverity;
  
  // Repeated failure threshold for auto-pause
  repeatedFailureThreshold: number;
}

// ============================================================================
// Default Policy
// ============================================================================

const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  pauseOnCriticalPolicyDenial: true,
  pauseOnWatchdogSuspend: true,
  pauseOnDlqOverflow: false, // DLQ overflow usually handled by retry
  pauseOnRepeatedOrchestrationFailures: true,
  
  createHandoffOnPolicyDenial: true,
  createHandoffOnWatchdogTrigger: true,
  createHandoffOnManualEscalation: true,
  
  notifyOnPolicyDenial: true,
  notifyOnWatchdog: true,
  notifyOnDlqOverflow: true,
  notifyOnOrchestrationFailure: true,
  notifyOnPauseResume: true,
  
  minHandoffSeverity: "warning",
  repeatedFailureThreshold: 3,
};

// In-memory policy (can be overridden)
let currentPolicy: EscalationPolicy = { ...DEFAULT_ESCALATION_POLICY };

// Track repeated failures for auto-pause
const failureCounts: Record<string, { count: number; lastFailure: string }> = {};

// ============================================================================
// Core API
// ============================================================================

/**
 * Handle an escalation trigger.
 * This is the main entry point for integrating triggers with escalation actions.
 * 
 * @param context - The trigger context
 * @returns The escalation actions taken
 */
export async function handleEscalationTrigger(
  context: TriggerContext
): Promise<EscalationAction> {
  const actionId = randomUUID();
  const timestamp = new Date().toISOString();
  
  const action: EscalationAction = {
    actionId,
    timestamp,
    pause: false,
    handoff: false,
    notification: false,
    reason: `Escalation triggered by ${context.source}`,
  };

  // Determine severity
  const severity = context.severity || "warning";
  
  // Determine notification type
  const notificationType = mapSourceToNotificationType(context.source);

  // Check if we should pause
  const shouldPauseResult = shouldPause(context);
  if (shouldPauseResult) {
    const pauseMode = determinePauseMode(context);
    try {
      await pause(pauseMode, {
        reason: `Auto-paused due to ${context.source}: ${context.message || "No details"}`,
        pausedBy: "escalation-system",
      });
      action.pause = true;
      action.pauseMode = pauseMode;
    } catch (err) {
      console.error(`[escalation] Failed to pause: ${err}`);
    }
  }

  // Check if we should create handoff
  const shouldCreateHandoffResult = shouldCreateHandoff(context);
  if (shouldCreateHandoffResult) {
    try {
      const handoffSeverity = mapToHandoffSeverity(severity);
      const handoffContext: HandoffContext = {
        workflowIds: context.workflowId ? [context.workflowId] : undefined,
        sessionId: context.sessionId,
        claudeSessionId: context.claudeSessionId,
        source: context.sourceChannel,
        channelId: context.channelId,
        threadId: context.threadId,
        relatedEventIds: context.eventId ? [context.eventId] : undefined,
      };
      
      await createHandoff(
        `Escalation from ${context.source}: ${context.message || "Trigger activated"}`,
        handoffContext,
        {
          severity: handoffSeverity,
          summary: context.message || `Escalation triggered by ${context.source}`,
          metadata: context.details,
        }
      );
      action.handoff = true;
    } catch (err) {
      console.error(`[escalation] Failed to create handoff: ${err}`);
    }
  }

  // Check if we should send notification
  const shouldNotifyResult = shouldNotify(context);
  if (shouldNotifyResult) {
    try {
      await notify(notificationType, severity, context.message || `Escalation: ${context.source}`, {
        eventId: context.eventId,
        workflowId: context.workflowId,
        sessionId: context.sessionId,
        details: context.details,
      });
      action.notification = true;
      action.notificationType = notificationType;
    } catch (err) {
      console.error(`[escalation] Failed to notify: ${err}`);
    }
  }

  // Log escalation action
  await logAudit({
    timestamp,
    eventId: `escalation-${actionId}`,
    requestId: actionId,
    source: context.source,
    toolName: "EscalationTrigger",
    action: severity === "critical" ? "require_approval" : "allow",
    reason: action.reason,
    metadata: {
      pause: action.pause,
      handoff: action.handoff,
      notification: action.notification,
      context: {
        eventId: context.eventId,
        workflowId: context.workflowId,
        sessionId: context.sessionId,
      },
    },
  });

  console.log(`[escalation] Handled ${context.source} trigger: pause=${action.pause}, handoff=${action.handoff}, notify=${action.notification}`);

  return action;
}

/**
 * Determine if the system should pause based on a trigger.
 * 
 * @param context - The trigger context
 * @returns True if the system should pause
 */
export function shouldPause(context: TriggerContext): boolean {
  const { source, severity, watchdogDecision } = context;

  switch (source) {
    case "policy_denial":
      return currentPolicy.pauseOnCriticalPolicyDenial && severity === "critical";

    case "watchdog":
      if (!currentPolicy.pauseOnWatchdogSuspend) return false;
      // Pause on suspend or kill states
      return watchdogDecision?.state === "suspend" || watchdogDecision?.state === "kill";

    case "dlq_overflow":
      return currentPolicy.pauseOnDlqOverflow;

    case "orchestration_failure":
      if (!currentPolicy.pauseOnRepeatedOrchestrationFailures) return false;
      
      // Track repeated failures
      const key = context.workflowId || context.sessionId || "global";
      const now = new Date().toISOString();
      
      if (!failureCounts[key]) {
        failureCounts[key] = { count: 1, lastFailure: now };
        return false;
      }
      
      // Reset count if last failure was more than 5 minutes ago
      const lastFailure = new Date(failureCounts[key].lastFailure);
      if (Date.now() - lastFailure.getTime() > 300000) {
        failureCounts[key] = { count: 1, lastFailure: now };
        return false;
      }
      
      failureCounts[key].count++;
      failureCounts[key].lastFailure = now;
      
      return failureCounts[key].count >= currentPolicy.repeatedFailureThreshold;

    case "manual_escalation":
      // Manual escalations don't auto-pause
      return false;

    case "policy_approval_timeout":
      // Approval timeouts don't auto-pause
      return false;

    default:
      return false;
  }
}

/**
 * Determine if a handoff should be created based on a trigger.
 * 
 * @param context - The trigger context
 * @returns True if a handoff should be created
 */
export function shouldCreateHandoff(context: TriggerContext): boolean {
  const { source, severity } = context;
  
  // Check minimum severity
  const severityOrder: HandoffSeverity[] = ["info", "warning", "critical"];
  const minIndex = severityOrder.indexOf(currentPolicy.minHandoffSeverity);
  const severityIndex = severityOrder.indexOf((severity as HandoffSeverity) || "info");
  
  if (severityIndex < minIndex) {
    return false;
  }

  switch (source) {
    case "policy_denial":
      return currentPolicy.createHandoffOnPolicyDenial;

    case "watchdog":
      return currentPolicy.createHandoffOnWatchdogTrigger;

    case "manual_escalation":
      return currentPolicy.createHandoffOnManualEscalation;

    case "dlq_overflow":
      // DLQ overflow usually handled by retry, but create handoff if critical
      return severity === "critical";

    case "orchestration_failure":
      // Create handoff for repeated failures
      return severity === "critical";

    case "policy_approval_timeout":
      return true;

    default:
      return false;
  }
}

/**
 * Determine if a notification should be sent based on a trigger.
 * 
 * @param context - The trigger context
 * @returns True if a notification should be sent
 */
export function shouldNotify(context: TriggerContext): boolean {
  const { source } = context;

  switch (source) {
    case "policy_denial":
      return currentPolicy.notifyOnPolicyDenial;

    case "watchdog":
      return currentPolicy.notifyOnWatchdog;

    case "dlq_overflow":
      return currentPolicy.notifyOnDlqOverflow;

    case "orchestration_failure":
      return currentPolicy.notifyOnOrchestrationFailure;

    case "manual_escalation":
      return true;

    case "policy_approval_timeout":
      return true;

    default:
      return true;
  }
}

// ============================================================================
// Policy Management
// ============================================================================

/**
 * Configure the escalation policy.
 */
export function configureEscalationPolicy(policy: Partial<EscalationPolicy>): void {
  currentPolicy = {
    ...currentPolicy,
    ...policy,
  };
  console.log("[escalation] Policy updated");
}

/**
 * Get the current escalation policy.
 */
export function getEscalationPolicy(): EscalationPolicy {
  return { ...currentPolicy };
}

/**
 * Reset the escalation policy to defaults.
 */
export function resetEscalationPolicy(): void {
  currentPolicy = { ...DEFAULT_ESCALATION_POLICY };
  // Clear failure counts
  for (const key of Object.keys(failureCounts)) {
    delete failureCounts[key];
  }
}

// ============================================================================
// Convenience Methods for Specific Triggers
// ============================================================================

/**
 * Handle a policy denial trigger.
 */
export async function handlePolicyDenial(
  eventId: string,
  toolName: string,
  reason: string,
  options?: {
    severity?: "warning" | "critical";
    channelId?: string;
    sessionId?: string;
    workflowId?: string;
  }
): Promise<EscalationAction> {
  return handleEscalationTrigger({
    source: "policy_denial",
    eventId,
    channelId: options?.channelId,
    sessionId: options?.sessionId,
    workflowId: options?.workflowId,
    severity: options?.severity || "warning",
    message: `Policy denied ${toolName}: ${reason}`,
    details: { toolName, reason },
  });
}

/**
 * Handle a watchdog trigger.
 */
export async function handleWatchdogTrigger(
  decision: WatchdogDecision,
  context: {
    invocationId: string;
    sessionId?: string;
  }
): Promise<EscalationAction> {
  const severity = decision.state === "kill" ? "critical" : 
                   decision.state === "suspend" ? "warning" : "info";
  
  return handleEscalationTrigger({
    source: "watchdog",
    sessionId: context.sessionId,
    severity,
    message: `Watchdog ${decision.state}: ${decision.reason}`,
    details: { decision, invocationId: context.invocationId },
    watchdogDecision: decision,
  });
}

/**
 * Handle a DLQ overflow trigger.
 */
export async function handleDlqOverflow(
  dlqSize: number,
  threshold: number,
  options?: {
    eventId?: string;
    workflowId?: string;
  }
): Promise<EscalationAction> {
  const severity = dlqSize > threshold * 2 ? "critical" : "warning";
  
  return handleEscalationTrigger({
    source: "dlq_overflow",
    eventId: options?.eventId,
    workflowId: options?.workflowId,
    severity,
    message: `DLQ overflow: ${dlqSize} items (threshold: ${threshold})`,
    details: { dlqSize, threshold },
  });
}

/**
 * Handle an orchestration failure trigger.
 */
export async function handleOrchestrationFailure(
  workflowId: string,
  error: string,
  options?: {
    sessionId?: string;
    eventId?: string;
  }
): Promise<EscalationAction> {
  // Check if this is a repeated failure
  const count = failureCounts[workflowId]?.count || 0;
  const severity = count >= currentPolicy.repeatedFailureThreshold - 1 ? "critical" : "warning";
  
  return handleEscalationTrigger({
    source: "orchestration_failure",
    workflowId,
    sessionId: options?.sessionId,
    eventId: options?.eventId,
    severity,
    message: `Orchestration failure: ${error}`,
    details: { workflowId, error, failureCount: count + 1 },
  });
}

/**
 * Handle a manual escalation trigger.
 */
export async function handleManualEscalation(
  reason: string,
  options?: {
    severity?: HandoffSeverity;
    eventId?: string;
    workflowId?: string;
    sessionId?: string;
    channelId?: string;
  }
): Promise<EscalationAction> {
  return handleEscalationTrigger({
    source: "manual_escalation",
    eventId: options?.eventId,
    workflowId: options?.workflowId,
    sessionId: options?.sessionId,
    channelId: options?.channelId,
    severity: (options?.severity as "info" | "warning" | "critical") || "warning",
    message: `Manual escalation: ${reason}`,
    details: { reason },
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

function mapSourceToNotificationType(source: TriggerSource): NotificationType {
  switch (source) {
    case "policy_denial":
    case "policy_approval_timeout":
      return "policy_denial";
    case "watchdog":
      return "watchdog";
    case "dlq_overflow":
      return "dlq_overflow";
    case "orchestration_failure":
      return "error";
    case "manual_escalation":
      return "manual_escalation";
    default:
      return "error";
  }
}

function mapToHandoffSeverity(severity: "info" | "warning" | "critical"): HandoffSeverity {
  return severity as HandoffSeverity;
}

function determinePauseMode(context: TriggerContext): PauseMode {
  // For critical issues, pause both admission and scheduling
  if (context.severity === "critical" || context.watchdogDecision?.state === "kill") {
    return "admission_and_scheduling";
  }
  
  // For less severe issues, only pause admission
  return "admission_only";
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Reset the trigger integration (for testing only).
 */
export function resetTriggerIntegration(): void {
  resetEscalationPolicy();
}

/**
 * Get current failure counts (for testing only).
 */
export function getFailureCounts(): Record<string, { count: number; lastFailure: string }> {
  return { ...failureCounts };
}

/**
 * Clear failure count for a key (for testing only).
 */
export function clearFailureCount(key: string): void {
  delete failureCounts[key];
}
