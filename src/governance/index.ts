/**
 * Governance Module Index
 * 
 * Exposes all governance modules from a single entry point.
 */

// Usage Tracker
export {
  initUsageTracker,
  recordInvocationStart,
  recordInvocationCompletion,
  recordInvocationFailure,
  recordInvocationKilled,
  getInvocation,
  getSessionUsage,
  getChannelUsage,
  getAggregates,
  getUsageStats,
  getAllUsageRecords,
  resetUsageTracker,
  type InvocationStatus,
  type UsageMetrics,
  type EstimatedCost,
  type InvocationUsageRecord,
  type InvocationContext,
  type UsageFilters,
} from "./usage-tracker";

// Budget Engine
export {
  initBudgetEngine,
  evaluateBudget,
  getBudgetState,
  upsertBudgetPolicy,
  deleteBudgetPolicy,
  loadPricingConfig,
  loadPolicies,
  calculateEstimatedCost,
  createDefaultPoliciesForChannel,
  resetBudgetEngine,
  type BudgetPeriod,
  type BudgetState,
  type BudgetThreshold,
  type BudgetActionDefaults,
  type BudgetScope,
  type BudgetPolicy,
  type PricingTier,
  type PricingConfig,
  type BudgetEvaluation,
  type BudgetStateSummary,
} from "./budget-engine";

// Model Router
export {
  selectModel,
  getFallbackChain,
  isModelAllowed,
  configureRouter,
  getRouterConfig,
  type ModelRoutingDecision,
  type ModelRequestContext,
} from "./model-router";

// Watchdog
export {
  initWatchdog,
  recordExecutionMetric,
  incrementToolCall,
  incrementTurnCount,
  checkLimits,
  handleTrigger,
  getActiveInvocation,
  getSessionActiveInvocations,
  clearInvocation,
  getWatchdogStats,
  configureWatchdog,
  getWatchdogConfig,
  resetWatchdog,
  type WatchdogState,
  type WatchdogLimits,
  type ExecutionMetrics,
  type WatchdogDecision,
  type WatchdogConfig,
} from "./watchdog";

// Telemetry
export {
  getTelemetry,
  getTelemetrySummary,
  getProviderBreakdown,
  getModelBreakdown,
  getChannelBreakdown,
  getBudgetHealth,
  type GovernanceTelemetry,
  type TelemetryFilters,
} from "./telemetry";

// GovernanceClient
export {
  GovernanceClient,
  getGovernanceClient,
  initGovernanceClient,
  type GovernanceClientConfig,
} from "./client";
