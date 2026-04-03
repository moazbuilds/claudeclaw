/**
 * Governance Telemetry
 * 
 * Exposes persisted governance state and derived aggregates to API/dashboard consumers.
 * 
 * PRINCIPLES:
 * - Telemetry is read-side only
 * - Telemetry derives from persisted usage/governance records
 * - Cached aggregates may exist, but persisted records remain canonical
 * - Real-time updates are optional and only added if architecture supports them
 */

import { getAggregates, type UsageFilters } from "./usage-tracker";
import { getBudgetState, type BudgetScope } from "./budget-engine";

export interface GovernanceTelemetry {
  // Session stats
  totalSessions: number;
  activeSessions: number;
  
  // Cost stats
  estimatedTotalCost: number;
  currency: string;
  
  // Channel stats
  channelStats: Record<string, {
    sessions: number;
    estimatedCost: number;
    tokens: number;
    invocations: number;
  }>;
  
  // Provider stats
  providerStats: Record<string, {
    calls: number;
    tokens: number;
    estimatedCost: number;
  }>;
  
  // Model stats
  modelStats: Record<string, {
    calls: number;
    tokens: number;
    estimatedCost: number;
  }>;
  
  // Budget states
  budgetStates: Record<string, {
    status: string;
    scope: string;
    currentSpend?: number;
    threshold?: number;
  }>;
  
  // Watchdog stats
  watchdog: {
    triggered: number;
    warned: number;
    killed: number;
    suspended: number;
  };
  
  // Invocation stats
  invocationStats: {
    total: number;
    completed: number;
    failed: number;
    killed: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
  };
}

export interface TelemetryFilters {
  startDate?: string;
  endDate?: string;
  channelId?: string;
  source?: string;
  provider?: string;
  model?: string;
}

/**
 * Get comprehensive governance telemetry.
 */
export async function getTelemetry(filters: TelemetryFilters = {}): Promise<GovernanceTelemetry> {
  // Get usage aggregates
  const usageFilters: UsageFilters = {
    startDate: filters.startDate,
    endDate: filters.endDate,
    channelId: filters.channelId,
    source: filters.source,
    provider: filters.provider,
    model: filters.model,
  };

  const aggregates = await getAggregates(usageFilters);

  // Get budget states
  const budgetScope: BudgetScope = {};
  if (filters.channelId) {
    budgetScope.channelId = filters.channelId;
  }
  const budgetStates = await getBudgetState(budgetScope);

  // Build telemetry response
  const telemetry: GovernanceTelemetry = {
    // Session stats (derived from usage records)
    totalSessions: new Set(
      Object.values(aggregates.byChannel).map(() => "")
    ).size || Object.keys(aggregates.byChannel).length,
    activeSessions: 0, // Would need active session tracking

    // Cost stats
    estimatedTotalCost: aggregates.totalEstimatedCost,
    currency: "USD", // Default currency

    // Channel stats
    channelStats: Object.fromEntries(
      Object.entries(aggregates.byChannel).map(([channelId, stats]) => [
        channelId,
        {
          sessions: 0, // Would need session-level tracking
          estimatedCost: stats.cost,
          tokens: stats.tokens,
          invocations: stats.count,
        },
      ])
    ),

    // Provider stats
    providerStats: Object.fromEntries(
      Object.entries(aggregates.byProvider).map(([provider, stats]) => [
        provider,
        {
          calls: stats.count,
          tokens: stats.tokens,
          estimatedCost: stats.cost,
        },
      ])
    ),

    // Model stats
    modelStats: Object.fromEntries(
      Object.entries(aggregates.byModel).map(([model, stats]) => [
        model,
        {
          calls: stats.count,
          tokens: stats.tokens,
          estimatedCost: stats.cost,
        },
      ])
    ),

    // Budget states
    budgetStates: Object.fromEntries(
      budgetStates.map((bs) => [
        bs.policyId,
        {
          status: bs.state,
          scope: JSON.stringify(bs),
          currentSpend: bs.currentSpend,
          threshold: bs.threshold ?? undefined,
        },
      ])
    ),

    // Watchdog stats (placeholder - would need watchdog event tracking)
    watchdog: {
      triggered: 0,
      warned: 0,
      killed: aggregates.killedInvocations,
      suspended: 0,
    },

    // Invocation stats
    invocationStats: {
      total: aggregates.totalInvocations,
      completed: aggregates.completedInvocations,
      failed: aggregates.failedInvocations,
      killed: aggregates.killedInvocations,
      byProvider: Object.fromEntries(
        Object.entries(aggregates.byProvider).map(([p, v]) => [p, v.count])
      ),
      byModel: Object.fromEntries(
        Object.entries(aggregates.byModel).map(([m, v]) => [m, v.count])
      ),
    },
  };

  return telemetry;
}

/**
 * Get lightweight summary for quick overview.
 */
export async function getTelemetrySummary(): Promise<{
  totalInvocations: number;
  estimatedTotalCost: number;
  activeBudgets: number;
  blockedBudgets: number;
}> {
  const aggregates = await getAggregates({});
  const budgetStates = await getBudgetState({});

  return {
    totalInvocations: aggregates.totalInvocations,
    estimatedTotalCost: aggregates.totalEstimatedCost,
    activeBudgets: budgetStates.filter((b) => b.state !== "healthy").length,
    blockedBudgets: budgetStates.filter((b) => b.state === "block").length,
  };
}

/**
 * Get provider breakdown.
 */
export async function getProviderBreakdown(): Promise<Array<{
  provider: string;
  calls: number;
  tokens: number;
  estimatedCost: number;
  avgCostPerCall: number;
}>> {
  const aggregates = await getAggregates({});

  return Object.entries(aggregates.byProvider).map(([provider, stats]) => ({
    provider,
    calls: stats.count,
    tokens: stats.tokens,
    estimatedCost: stats.cost,
    avgCostPerCall: stats.count > 0 ? stats.cost / stats.count : 0,
  }));
}

/**
 * Get model breakdown.
 */
export async function getModelBreakdown(): Promise<Array<{
  model: string;
  provider: string;
  calls: number;
  tokens: number;
  estimatedCost: number;
  avgCostPerCall: number;
}>> {
  const aggregates = await getAggregates({});

  return Object.entries(aggregates.byModel).map(([model, stats]) => {
    // Extract provider from model name (heuristic)
    const provider = model.includes("-") ? model.split("-")[0] : "unknown";
    return {
      model,
      provider,
      calls: stats.count,
      tokens: stats.tokens,
      estimatedCost: stats.cost,
      avgCostPerCall: stats.count > 0 ? stats.cost / stats.count : 0,
    };
  });
}

/**
 * Get channel breakdown.
 */
export async function getChannelBreakdown(): Promise<Array<{
  channelId: string;
  sessions: number;
  invocations: number;
  tokens: number;
  estimatedCost: number;
}>> {
  const aggregates = await getAggregates({});

  return Object.entries(aggregates.byChannel).map(([channelId, stats]) => ({
    channelId,
    sessions: 0, // Would need session tracking per channel
    invocations: stats.count,
    tokens: stats.tokens,
    estimatedCost: stats.cost,
  }));
}

/**
 * Get budget health summary.
 */
export async function getBudgetHealth(): Promise<Array<{
  policyId: string;
  policyName: string;
  state: string;
  currentSpend: number;
  threshold: number | null;
  percentage: number;
  currency: string;
}>> {
  const budgetStates = await getBudgetState({});

  return budgetStates.map((bs) => ({
    policyId: bs.policyId,
    policyName: bs.policyName,
    state: bs.state,
    currentSpend: bs.currentSpend,
    threshold: bs.threshold,
    percentage: bs.percentage,
    currency: bs.currency,
  }));
}
