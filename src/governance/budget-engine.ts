/**
 * Pricing & Budget Engine
 * 
 * Evaluates spend/usage against configured budget policies and returns governance actions.
 * 
 * BUDGET MODEL:
 * - Budgets are scoped (session, daily, monthly)
 * - Thresholds: warn, degrade, reroute, block
 * - Actions are policy-driven, not hard-coded
 * - Cost is always labeled as ESTIMATED
 */

import { join } from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { 
  getAggregates, 
  getSessionUsage, 
  type UsageFilters 
} from "./usage-tracker";

const CLAUDECLAW_DIR = join(process.cwd(), ".claude", "claudeclaw");
const BUDGET_POLICIES_FILE = join(CLAUDECLAW_DIR, "budget-policies.json");
const PRICING_FILE = join(CLAUDECLAW_DIR, "pricing.json");

export type BudgetPeriod = "session" | "daily" | "monthly";
export type BudgetState = "healthy" | "warn" | "degrade" | "reroute" | "block";

export interface BudgetThreshold {
  warnAt?: number;
  degradeAt?: number;
  rerouteAt?: number;
  blockAt?: number;
}

export interface BudgetActionDefaults {
  degradeToModel?: string;
  rerouteToProvider?: string;
}

export interface BudgetScope {
  source?: string | string[];
  channelId?: string | string[];
  userId?: string | string[];
  sessionId?: string | string[];
  model?: string | string[];
  provider?: string | string[];
}

export interface BudgetPolicy {
  id: string;
  name: string;
  scope: BudgetScope;
  thresholds: BudgetThreshold;
  period: BudgetPeriod;
  currency: string;
  actionDefaults?: BudgetActionDefaults;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PricingTier {
  provider: string;
  model: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  currency: string;
}

export interface PricingConfig {
  version: string;
  updatedAt: string;
  tiers: PricingTier[];
}

export interface BudgetEvaluation {
  policyId: string;
  policyName: string;
  state: BudgetState;
  currentSpend: number;
  threshold: number | null;
  percentage: number;
  period: BudgetPeriod;
  currency: string;
  actions: {
    shouldWarn: boolean;
    shouldDegrade: boolean;
    shouldReroute: boolean;
    shouldBlock: boolean;
    degradeToModel?: string;
    rerouteToProvider?: string;
  };
  evaluatedAt: string;
}

export interface BudgetStateSummary {
  policyId: string;
  policyName: string;
  state: BudgetState;
  currentSpend: number;
  threshold: number | null;
  percentage: number;
  period: BudgetPeriod;
  currency: string;
}

// In-memory cache
let budgetPolicies: BudgetPolicy[] | null = null;
let pricingConfig: PricingConfig | null = null;
let initializationPromise: Promise<void> | null = null;

export function resetBudgetEngine(): void {
  budgetPolicies = null;
  pricingConfig = null;
  initializationPromise = null;
}

/**
 * Initialize the budget engine.
 */
export async function initBudgetEngine(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = doInit();
  return initializationPromise;
}

async function doInit(): Promise<void> {
  await loadBudgetPolicies();
  await loadPricing();
}

async function loadBudgetPolicies(): Promise<BudgetPolicy[]> {
  if (budgetPolicies !== null) {
    return budgetPolicies;
  }

  try {
    if (existsSync(BUDGET_POLICIES_FILE)) {
      const data = await Bun.file(BUDGET_POLICIES_FILE).json();
      if (Array.isArray(data.policies)) {
        budgetPolicies = data.policies;
        return budgetPolicies;
      }
    }
  } catch {
    // Fall through to defaults
  }

  // Default empty policies
  budgetPolicies = [];
  return budgetPolicies;
}

async function loadPricing(): Promise<PricingConfig> {
  if (pricingConfig !== null) {
    return pricingConfig;
  }

  try {
    if (existsSync(PRICING_FILE)) {
      const data = await Bun.file(PRICING_FILE).json();
      if (data.version && Array.isArray(data.tiers)) {
        pricingConfig = data;
        return pricingConfig;
      }
    }
  } catch {
    // Fall through to defaults
  }

  // Default pricing (Anthropic-focused, others can be added)
  pricingConfig = {
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    tiers: [
      {
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        inputCostPerMillion: 3.0,
        outputCostPerMillion: 15.0,
        cacheReadCostPerMillion: 0.3,
        cacheCreationCostPerMillion: 3.75,
        currency: "USD",
      },
      {
        provider: "anthropic",
        model: "claude-3-haiku",
        inputCostPerMillion: 0.25,
        outputCostPerMillion: 1.25,
        cacheReadCostPerMillion: 0.03,
        cacheCreationCostPerMillion: 0.03,
        currency: "USD",
      },
      {
        provider: "openai",
        model: "gpt-4o",
        inputCostPerMillion: 5.0,
        outputCostPerMillion: 15.0,
        currency: "USD",
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        inputCostPerMillion: 0.15,
        outputCostPerMillion: 0.6,
        currency: "USD",
      },
      {
        provider: "google",
        model: "glm-4",
        inputCostPerMillion: 0.27,
        outputCostPerMillion: 1.07,
        currency: "USD",
      },
    ],
  };

  await savePricing();
  return pricingConfig;
}

async function savePricing(): Promise<void> {
  if (!pricingConfig) return;
  pricingConfig.updatedAt = new Date().toISOString();
  await Bun.write(PRICING_FILE, JSON.stringify(pricingConfig, null, 2) + "\n");
}

async function saveBudgetPolicies(): Promise<void> {
  if (!budgetPolicies) return;
  await Bun.write(
    BUDGET_POLICIES_FILE,
    JSON.stringify({ policies: budgetPolicies, updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );
}

/**
 * Load pricing configuration.
 */
export async function loadPricingConfig(): Promise<PricingConfig> {
  await initBudgetEngine();
  return pricingConfig!;
}

/**
 * Load budget policies.
 */
export async function loadPolicies(): Promise<BudgetPolicy[]> {
  await initBudgetEngine();
  return budgetPolicies!;
}

/**
 * Add or update a budget policy.
 */
export async function upsertBudgetPolicy(
  policyData: Omit<BudgetPolicy, "id" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<BudgetPolicy> {
  await initBudgetEngine();

  const now = new Date().toISOString();
  const policyId = policyData.id;
  
  if (policyId) {
    // Update existing
    const index = budgetPolicies!.findIndex(p => p.id === policyId);
    if (index >= 0) {
      budgetPolicies![index] = {
        ...budgetPolicies![index],
        ...policyData,
        id: policyId,
        updatedAt: now,
      };
      await saveBudgetPolicies();
      return budgetPolicies![index];
    }
  }

  // Create new
  const newPolicy: BudgetPolicy = {
    ...policyData,
    id: policyId || randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  budgetPolicies!.push(newPolicy);
  await saveBudgetPolicies();
  return newPolicy;
}

/**
 * Delete a budget policy.
 */
export async function deleteBudgetPolicy(policyId: string): Promise<boolean> {
  await initBudgetEngine();

  const index = budgetPolicies!.findIndex(p => p.id === policyId);
  if (index < 0) {
    return false;
  }

  budgetPolicies!.splice(index, 1);
  await saveBudgetPolicies();
  return true;
}

/**
 * Calculate estimated cost from usage metrics.
 */
export function calculateEstimatedCost(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  },
  provider: string,
  model: string
): { totalCost: number; breakdown: { inputCost: number; outputCost: number; cacheCost: number } } | null {
  if (!pricingConfig) {
    return null;
  }

  const tier = pricingConfig.tiers.find(t => t.provider === provider && t.model === model);
  if (!tier) {
    // Try just provider-level default
    const providerTier = pricingConfig.tiers.find(t => t.provider === provider);
    if (!providerTier) {
      return null;
    }
  }

  const selectedTier = tier || pricingConfig.tiers.find(t => t.provider === provider)!;

  const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * selectedTier.inputCostPerMillion;
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * selectedTier.outputCostPerMillion;
  
  let cacheCost = 0;
  if (selectedTier.cacheCreationCostPerMillion && usage.cacheCreationInputTokens) {
    cacheCost += (usage.cacheCreationInputTokens / 1_000_000) * selectedTier.cacheCreationCostPerMillion;
  }
  if (selectedTier.cacheReadCostPerMillion && usage.cacheReadInputTokens) {
    cacheCost += (usage.cacheReadInputTokens / 1_000_000) * selectedTier.cacheReadCostPerMillion;
  }

  const totalCost = inputCost + outputCost + cacheCost;

  return {
    totalCost,
    breakdown: {
      inputCost,
      outputCost,
      cacheCost,
    },
  };
}

function matchesScope(record: { source?: string; channelId?: string; sessionId?: string; provider?: string; model?: string }, scope: BudgetScope): boolean {
  // Check source
  if (scope.source) {
    const sources = Array.isArray(scope.source) ? scope.source : [scope.source];
    if (!record.source || !sources.includes(record.source)) {
      return false;
    }
  }

  // Check channelId
  if (scope.channelId) {
    const channels = Array.isArray(scope.channelId) ? scope.channelId : [scope.channelId];
    if (!record.channelId || !channels.includes(record.channelId)) {
      return false;
    }
  }

  // Check sessionId
  if (scope.sessionId) {
    const sessions = Array.isArray(scope.sessionId) ? scope.sessionId : [scope.sessionId];
    if (!record.sessionId || !sessions.includes(record.sessionId)) {
      return false;
    }
  }

  // Check provider
  if (scope.provider) {
    const providers = Array.isArray(scope.provider) ? scope.provider : [scope.provider];
    if (!record.provider || !providers.includes(record.provider)) {
      return false;
    }
  }

  // Check model
  if (scope.model) {
    const models = Array.isArray(scope.model) ? scope.model : [scope.model];
    if (!record.model || !models.includes(record.model)) {
      return false;
    }
  }

  return true;
}

function getPeriodBounds(period: BudgetPeriod): { startDate: string; endDate: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  let startDate: string;
  let endDate: string;

  switch (period) {
    case "session":
      // Session is unbounded in time - use all records
      startDate = "1970-01-01T00:00:00Z";
      endDate = "2099-12-31T23:59:59Z";
      break;

    case "daily":
      startDate = new Date(Date.UTC(year, month, day, 0, 0, 0, 0)).toISOString();
      endDate = new Date(Date.UTC(year, month, day, 23, 59, 59, 999)).toISOString();
      break;

    case "monthly":
      startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString();
      endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)).toISOString();
      break;
  }

  return { startDate, endDate };
}

/**
 * Evaluate budget for a given context.
 */
export async function evaluateBudget(
  context: {
    sessionId?: string;
    channelId?: string;
    source?: string;
    userId?: string;
    provider?: string;
    model?: string;
  }
): Promise<BudgetEvaluation[]> {
  await initBudgetEngine();

  const evaluations: BudgetEvaluation[] = [];

  for (const policy of budgetPolicies!) {
    if (!policy.enabled) {
      continue;
    }

    // Check if context matches policy scope
    if (!matchesScope(context, policy.scope)) {
      continue;
    }

    // Get period bounds
    const { startDate, endDate } = getPeriodBounds(policy.period);

    // Get usage for the period
    const filters: UsageFilters = {
      startDate,
      endDate,
      sessionId: policy.period === "session" ? context.sessionId : undefined,
      channelId: context.channelId,
      source: context.source,
      provider: context.provider,
      model: context.model,
    };

    const aggregates = await getAggregates(filters);

    const currentSpend = aggregates.totalEstimatedCost;
    const { thresholds } = policy;

    // Determine state
    let state: BudgetState = "healthy";
    let threshold: number | null = null;
    let percentage = 0;

    if (thresholds.blockAt !== undefined && currentSpend >= thresholds.blockAt) {
      state = "block";
      threshold = thresholds.blockAt;
      percentage = (currentSpend / thresholds.blockAt) * 100;
    } else if (thresholds.rerouteAt !== undefined && currentSpend >= thresholds.rerouteAt) {
      state = "reroute";
      threshold = thresholds.rerouteAt;
      percentage = (currentSpend / thresholds.rerouteAt) * 100;
    } else if (thresholds.degradeAt !== undefined && currentSpend >= thresholds.degradeAt) {
      state = "degrade";
      threshold = thresholds.degradeAt;
      percentage = (currentSpend / thresholds.degradeAt) * 100;
    } else if (thresholds.warnAt !== undefined && currentSpend >= thresholds.warnAt) {
      state = "warn";
      threshold = thresholds.warnAt;
      percentage = (currentSpend / thresholds.warnAt) * 100;
    }

    // Determine actions
    const actions = {
      shouldWarn: state !== "healthy",
      shouldDegrade: state === "degrade" || state === "reroute" || state === "block",
      shouldReroute: state === "reroute" || state === "block",
      shouldBlock: state === "block",
      degradeToModel: policy.actionDefaults?.degradeToModel,
      rerouteToProvider: policy.actionDefaults?.rerouteToProvider,
    };

    evaluations.push({
      policyId: policy.id,
      policyName: policy.name,
      state,
      currentSpend,
      threshold,
      percentage,
      period: policy.period,
      currency: policy.currency,
      actions,
      evaluatedAt: new Date().toISOString(),
    });
  }

  return evaluations;
}

/**
 * Get current budget state for a scope.
 */
export async function getBudgetState(
  scope: BudgetScope
): Promise<BudgetStateSummary[]> {
  await initBudgetEngine();

  const summaries: BudgetStateSummary[] = [];

  for (const policy of budgetPolicies!) {
    if (!policy.enabled) {
      continue;
    }

    // Check if policy matches the requested scope
    if (!matchesScope(scope as { source?: string; channelId?: string; sessionId?: string; provider?: string; model?: string }, policy.scope)) {
      continue;
    }

    // Get period bounds
    const { startDate, endDate } = getPeriodBounds(policy.period);

    // Get usage for the period
    const filters: UsageFilters = {
      startDate,
      endDate,
    };

    const aggregates = await getAggregates(filters);
    const currentSpend = aggregates.totalEstimatedCost;

    // Determine state
    let state: BudgetState = "healthy";
    let threshold: number | null = null;
    let percentage = 0;

    const { thresholds } = policy;

    if (thresholds.blockAt !== undefined && currentSpend >= thresholds.blockAt) {
      state = "block";
      threshold = thresholds.blockAt;
      percentage = (currentSpend / thresholds.blockAt) * 100;
    } else if (thresholds.rerouteAt !== undefined && currentSpend >= thresholds.rerouteAt) {
      state = "reroute";
      threshold = thresholds.rerouteAt;
      percentage = (currentSpend / thresholds.rerouteAt) * 100;
    } else if (thresholds.degradeAt !== undefined && currentSpend >= thresholds.degradeAt) {
      state = "degrade";
      threshold = thresholds.degradeAt;
      percentage = (currentSpend / thresholds.degradeAt) * 100;
    } else if (thresholds.warnAt !== undefined && currentSpend >= thresholds.warnAt) {
      state = "warn";
      threshold = thresholds.warnAt;
      percentage = (currentSpend / thresholds.warnAt) * 100;
    }

    summaries.push({
      policyId: policy.id,
      policyName: policy.name,
      state,
      currentSpend,
      threshold,
      percentage,
      period: policy.period,
      currency: policy.currency,
    });
  }

  return summaries;
}

/**
 * Create default budget policies for a channel.
 */
export async function createDefaultPoliciesForChannel(
  channelId: string,
  options: {
    dailyLimit?: number;
    monthlyLimit?: number;
  } = {}
): Promise<BudgetPolicy[]> {
  const policies: BudgetPolicy[] = [];

  if (options.dailyLimit) {
    const dailyPolicy = await upsertBudgetPolicy({
      id: randomUUID(),
      name: `Daily budget for ${channelId}`,
      scope: { channelId },
      thresholds: {
        warnAt: options.dailyLimit! * 0.7,
        degradeAt: options.dailyLimit! * 0.85,
        blockAt: options.dailyLimit!,
      },
      period: "daily",
      currency: "USD",
      enabled: true,
    });
    policies.push(dailyPolicy);
  }

  if (options.monthlyLimit) {
    const monthlyPolicy = await upsertBudgetPolicy({
      id: randomUUID(),
      name: `Monthly budget for ${channelId}`,
      scope: { channelId },
      thresholds: {
        warnAt: options.monthlyLimit! * 0.7,
        degradeAt: options.monthlyLimit! * 0.85,
        blockAt: options.monthlyLimit!,
      },
      period: "monthly",
      currency: "USD",
      enabled: true,
    });
    policies.push(monthlyPolicy);
  }

  return policies;
}
