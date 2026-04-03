/**
 * Governance-Aware Model Router
 * 
 * Selects provider/model combinations using policy, task context, capability requirements,
 * and budget state. Replaces the naive keyword-based router with an auditable,
 * policy-driven approach.
 */

import { randomUUID } from "crypto";
import { evaluateBudget, type BudgetEvaluation, type BudgetState } from "./budget-engine";
import { classifyTask, selectModel as legacySelectModel } from "../model-router";
import type { AgenticMode } from "../config";

export type { BudgetState };

export interface ModelRoutingDecision {
  requestId: string;
  selectedProvider: string;
  selectedModel: string;
  reason: string;
  matchedPolicyId?: string;
  budgetState?: BudgetState;
  fallbackChain?: Array<{ provider: string; model: string }>;
  decidedAt: string;
}

export interface ModelRequestContext {
  prompt?: string;
  taskType?: string;
  capability?: string;
  preferredProvider?: string;
  preferredModel?: string;
  explicitOverride?: {
    provider?: string;
    model?: string;
    allowed: boolean;
  };
  sessionId?: string;
  channelId?: string;
  source?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

interface RouterConfig {
  defaultProvider: string;
  defaultModel: string;
  modes?: AgenticMode[];
  defaultMode?: string;
  fallbackChain: Array<{ provider: string; model: string }>;
  degradeToModel?: string;
  rerouteToProvider?: string;
}

// Configuration for the router
let routerConfig: RouterConfig = {
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet",
  fallbackChain: [
    { provider: "anthropic", model: "claude-3-5-sonnet" },
    { provider: "anthropic", model: "claude-3-haiku" },
    { provider: "openai", model: "gpt-4o-mini" },
  ],
};

/**
 * Configure the model router.
 */
export function configureRouter(config: Partial<RouterConfig>): void {
  routerConfig = {
    ...routerConfig,
    ...config,
    fallbackChain: config.fallbackChain ?? routerConfig.fallbackChain,
  };
}

/**
 * Get current router configuration.
 */
export function getRouterConfig(): RouterConfig {
  return { ...routerConfig };
}

function determineBudgetState(evaluations: BudgetEvaluation[]): BudgetState {
  if (evaluations.length === 0) {
    return "healthy";
  }

  // Use the worst state across all applicable policies
  const statePriority: Record<BudgetState, number> = {
    healthy: 0,
    warn: 1,
    degrade: 2,
    reroute: 3,
    block: 4,
  };

  let worstState: BudgetState = "healthy";
  let highestPriority = 0;

  for (const eval_ of evaluations) {
    const priority = statePriority[eval_.state];
    if (priority > highestPriority) {
      highestPriority = priority;
      worstState = eval_.state;
    }
  }

  return worstState;
}

function findCheaperAlternative(
  currentProvider: string,
  currentModel: string
): { provider: string; model: string } | null {
  // Define cheaper alternatives per provider
  const cheaperAlternatives: Record<string, Record<string, { provider: string; model: string }>> = {
    "anthropic": {
      "claude-3-5-sonnet": { provider: "anthropic", model: "claude-3-haiku" },
      "claude-3-opus": { provider: "anthropic", model: "claude-3-5-sonnet" },
    },
    "openai": {
      "gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
      "gpt-4": { provider: "openai", model: "gpt-4o-mini" },
    },
  };

  const providerAlternatives = cheaperAlternatives[currentProvider];
  if (!providerAlternatives) {
    return null;
  }

  return providerAlternatives[currentModel] || null;
}

function findRerouteAlternative(
  currentProvider: string,
  rerouteToProvider?: string
): { provider: string; model: string } | null {
  // Provider-level reroute mapping
  const providerDefaults: Record<string, { provider: string; model: string }> = {
    "anthropic": { provider: "anthropic", model: "claude-3-haiku" },
    "openai": { provider: "openai", model: "gpt-4o-mini" },
    "google": { provider: "google", model: "glm-4" },
  };

  if (rerouteToProvider && providerDefaults[rerouteToProvider]) {
    return providerDefaults[rerouteToProvider];
  }

  // Fall back to finding any cheaper provider
  for (const [provider, defaultModel] of Object.entries(providerDefaults)) {
    if (provider !== currentProvider) {
      return defaultModel;
    }
  }

  return null;
}

/**
 * Select a model based on request context and budget state.
 */
export async function selectModel(requestContext: ModelRequestContext): Promise<ModelRoutingDecision> {
  const requestId = randomUUID();
  const now = new Date().toISOString();

  // Evaluate budget first
  const budgetEvaluations = await evaluateBudget({
    sessionId: requestContext.sessionId,
    channelId: requestContext.channelId,
    source: requestContext.source,
    userId: requestContext.userId,
    provider: requestContext.preferredProvider,
    model: requestContext.preferredModel,
  });

  const budgetState = determineBudgetState(budgetEvaluations);
  const worstEvaluation = budgetEvaluations.find(e => e.state === budgetState) ?? budgetEvaluations[0];

  // Check for explicit override
  if (requestContext.explicitOverride?.allowed && 
      (requestContext.explicitOverride.provider || requestContext.explicitOverride.model)) {
    // Override is allowed - use it but still consider budget state
    if (budgetState === "block") {
      return {
        requestId,
        selectedProvider: "",
        selectedModel: "",
        reason: "Execution blocked: budget limit exceeded",
        budgetState,
        fallbackChain: routerConfig.fallbackChain,
        decidedAt: now,
      };
    }

    return {
      requestId,
      selectedProvider: requestContext.explicitOverride.provider || routerConfig.defaultProvider,
      selectedModel: requestContext.explicitOverride.model || routerConfig.defaultModel,
      reason: "Explicit override applied (allowed by policy)",
      matchedPolicyId: worstEvaluation?.policyId,
      budgetState,
      fallbackChain: routerConfig.fallbackChain,
      decidedAt: now,
    };
  }

  // Determine base model selection
  let selectedProvider = routerConfig.defaultProvider;
  let selectedModel = routerConfig.defaultModel;
  let reason = "Default model selection";
  let finalBudgetState: BudgetState = budgetState;

  // If blocked, return early
  if (budgetState === "block") {
    finalBudgetState = "block";
    return {
      requestId,
      selectedProvider: "",
      selectedModel: "",
      reason: "Execution blocked: budget limit exceeded",
      budgetState: finalBudgetState,
      matchedPolicyId: worstEvaluation?.policyId,
      fallbackChain: routerConfig.fallbackChain,
      decidedAt: now,
    };
  }

  // Use task type / capability if provided
  if (requestContext.taskType && routerConfig.modes && routerConfig.modes.length > 0) {
    // Use legacy classification for task type
    if (requestContext.prompt && routerConfig.defaultMode) {
      const legacyResult = legacySelectModel(
        requestContext.prompt,
        routerConfig.modes,
        routerConfig.defaultMode
      );
      selectedModel = legacyResult.model;
      reason = `Task classified as "${legacyResult.taskType}": ${legacyResult.reasoning}`;
    }
  } else if (requestContext.capability) {
    // Map capability to model
    const capabilityModelMap: Record<string, { provider: string; model: string }> = {
      "coding": { provider: "anthropic", model: "claude-3-5-sonnet" },
      "analysis": { provider: "anthropic", model: "claude-3-5-sonnet" },
      "creative": { provider: "anthropic", model: "claude-3-5-sonnet" },
      "fast": { provider: "anthropic", model: "claude-3-haiku" },
      "simple": { provider: "anthropic", model: "claude-3-haiku" },
    };
    const mapped = capabilityModelMap[requestContext.capability.toLowerCase()];
    if (mapped) {
      selectedProvider = mapped.provider;
      selectedModel = mapped.model;
      reason = `Capability "${requestContext.capability}" mapped to ${mapped.provider}/${mapped.model}`;
    }
  }

  // Apply preferred provider/model if set
  if (requestContext.preferredProvider) {
    selectedProvider = requestContext.preferredProvider;
  }
  if (requestContext.preferredModel) {
    selectedModel = requestContext.preferredModel;
  }

  // Apply budget-aware modifications
  // Note: "block" is handled earlier with early return, so remaining states are "healthy"|"warn"|"degrade"|"reroute"
  const currentBudgetState = budgetState as "healthy" | "warn" | "degrade" | "reroute";
  if (currentBudgetState === "degrade" && worstEvaluation?.actions.degradeToModel) {
    const degradeParts = worstEvaluation.actions.degradeToModel.split("/");
    if (degradeParts.length === 2) {
      selectedProvider = degradeParts[0];
      selectedModel = degradeParts[1];
    } else {
      selectedModel = worstEvaluation.actions.degradeToModel;
    }
    reason = `Budget degrade: switched to ${selectedProvider}/${selectedModel}`;
  } else if (currentBudgetState === "reroute" && worstEvaluation?.actions.rerouteToProvider) {
    const reroute = findRerouteAlternative(selectedProvider, worstEvaluation.actions.rerouteToProvider);
    if (reroute) {
      selectedProvider = reroute.provider;
      selectedModel = reroute.model;
      reason = `Budget reroute: switched to ${selectedProvider}/${selectedModel}`;
    } else if (routerConfig.rerouteToProvider) {
      const fallback = findRerouteAlternative(selectedProvider, routerConfig.rerouteToProvider);
      if (fallback) {
        selectedProvider = fallback.provider;
        selectedModel = fallback.model;
        reason = `Budget reroute: switched to ${selectedProvider}/${selectedModel}`;
      }
    }
  } else if (currentBudgetState === "warn") {
    reason += ` (budget warning: ${worstEvaluation?.percentage.toFixed(1)}% of threshold)`;
  }
  // "healthy" state requires no special action

  // Build fallback chain based on budget state (block case handled earlier)
  let fallbackChain = routerConfig.fallbackChain;
  if (currentBudgetState === "degrade" || currentBudgetState === "reroute") {
    // Filter fallback chain to cheaper options
    fallbackChain = routerConfig.fallbackChain.filter(
      (f) => f.provider !== selectedProvider || f.model !== selectedModel
    );
  }

  return {
    requestId,
    selectedProvider,
    selectedModel,
    reason,
    matchedPolicyId: worstEvaluation?.policyId,
    budgetState,
    fallbackChain,
    decidedAt: now,
  };
}

/**
 * Get the fallback chain for a request context.
 */
export async function getFallbackChain(requestContext: ModelRequestContext): Promise<Array<{ provider: string; model: string }>> {
  const decision = await selectModel(requestContext);
  return decision.fallbackChain || routerConfig.fallbackChain;
}

/**
 * Check if a specific model selection is allowed given the context.
 */
export async function isModelAllowed(
  provider: string,
  model: string,
  context: ModelRequestContext
): Promise<{ allowed: boolean; reason: string }> {
  // Evaluate budget
  const evaluations = await evaluateBudget({
    sessionId: context.sessionId,
    channelId: context.channelId,
    source: context.source,
    userId: context.userId,
    provider,
    model,
  });

  const budgetState = determineBudgetState(evaluations);

  if (budgetState === "block") {
    return {
      allowed: false,
      reason: `Model ${provider}/${model} blocked: budget limit exceeded`,
    };
  }

  return {
    allowed: true,
    reason: "Model selection allowed",
  };
}
