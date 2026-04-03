/**
 * Escalation Module
 * 
 * Human escalation and operator intervention for ClaudeClaw.
 * 
 * This module provides:
 * - Pause/resume control for system intake and scheduling
 * - Structured handoff packages for human review
 * - Escalation notifications with rate limiting
 * - Trigger integration for policy, watchdog, and DLQ events
 * - Status views for operator dashboards
 * 
 * @example
 * ```typescript
 * import { pause, resume, createHandoff, notify, handleEscalationTrigger, getEscalationStatus } from "./escalation";
 * 
 * // Pause the system
 * await pause("admission_only", { reason: "Maintenance window" });
 * 
 * // Create a handoff for human review
 * await createHandoff("Needs operator review", { workflowId: "wf-123" });
 * 
 * // Send escalation notification
 * await notify("watchdog", "warning", "Watchdog triggered");
 * 
 * // Handle an escalation trigger
 * await handleEscalationTrigger({
 *   source: "policy_denial",
 *   severity: "critical",
 *   message: "Tool execution denied"
 * });
 * 
 * // Get current status
 * const status = await getEscalationStatus();
 * ```
 */

// Pause Controller
export {
  initPauseController,
  pause,
  resume,
  getPauseState,
  isPaused,
  shouldBlockAdmission,
  shouldBlockScheduling,
  getPauseHistory,
  resetPauseController,
  clearPauseCache,
  type PauseMode,
  type PauseState,
  type PauseAction,
  type PauseOptions,
  type ResumeOptions,
} from "./pause";

// Handoff Manager
export {
  initHandoffManager,
  createHandoff,
  getHandoff,
  listHandoffs,
  acceptHandoff,
  closeHandoff,
  getHandoffStats,
  resetHandoffManager,
  clearHandoffCache,
  type HandoffPackage,
  type HandoffContext,
  type HandoffSeverity,
  type HandoffStatus,
  type CreateHandoffOptions,
  type AcceptHandoffOptions,
  type CloseHandoffOptions,
  type HandoffFilters,
  type PendingEvent,
} from "./handoff";

// Notification Manager
export {
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
  type EscalationNotification,
  type NotificationDelivery,
  type EscalationConfig,
  type NotificationFilters,
} from "./notifications";

// Trigger Integration
export {
  handleEscalationTrigger,
  shouldPause,
  shouldCreateHandoff,
  shouldNotify,
  configureEscalationPolicy,
  getEscalationPolicy,
  resetEscalationPolicy,
  handlePolicyDenial,
  handleWatchdogTrigger,
  handleDlqOverflow,
  handleOrchestrationFailure,
  handleManualEscalation,
  resetTriggerIntegration,
  getFailureCounts,
  clearFailureCount,
  type TriggerSource,
  type TriggerContext,
  type EscalationAction,
  type EscalationPolicy,
} from "./triggers";

// Status View
export {
  getEscalationStatus,
  getEscalationSummary,
  requiresAttention,
  formatStatus,
  exportStatusAsJson,
  type EscalationStatus,
  type PauseStatus,
  type HandoffSummary,
  type NotificationSummary,
  type EscalationActionSummary,
  type EscalationSummary,
  type StatusFilters,
} from "./status";
