/**
 * Orchestrator Governance Adapter
 * 
 * Bridges the interface mismatch between the executor's GovernanceClient interface
 * and the actual GovernanceClient class from src/governance/client.ts.
 * 
 * Executor interface (target):
 *   checkPolicy(channelId: string, action: string): Promise<GovernanceCheck>
 *   checkBudget(sessionId: string, action: string): Promise<GovernanceCheck>
 * 
 * Real GovernanceClient (source):
 *   evaluateToolRequest(request: ToolRequestContext): PolicyDecision
 *   getBudgetState(channelId?: string)
 */

import type { GovernanceClient as RealGovernanceClient } from "../governance/client";
import { GovernanceClient as RealGovernanceClientClass } from "../governance/client";
import { getGovernanceClient } from "../governance/client";
import { evaluateBudget } from "../governance";
import type { ToolRequestContext } from "../policy/engine";
import type { GovernanceCheck, GovernanceClient } from "./executor";

export { OrchestratorGovernanceAdapter };

/**
 * Adapter that implements the executor's GovernanceClient interface
 * by wrapping the real GovernanceClient class.
 */
class OrchestratorGovernanceAdapter implements GovernanceClient {
  private realClient: RealGovernanceClient;

  /**
   * Create adapter with optional real client instance.
   * Defaults to singleton governance client if not provided.
   */
  constructor(realClient?: RealGovernanceClient) {
    this.realClient = realClient || getGovernanceClient();
  }

  /**
   * Check if an action is allowed by policy.
   * Translates executor's checkPolicy to real client's evaluateToolRequest.
   */
  async checkPolicy(channelId: string, action: string): Promise<GovernanceCheck> {
    // Build ToolRequestContext from executor's parameters
    const request: ToolRequestContext = {
      eventId: crypto.randomUUID(),
      source: "orchestrator",
      channelId,
      toolName: action,
      toolArgs: undefined,
      timestamp: new Date().toISOString(),
    };

    // evaluateToolRequest is synchronous but executor interface expects Promise
    // Wrap in Promise.resolve() to satisfy the async interface
    const decision = await Promise.resolve(this.realClient.evaluateToolRequest(request));

    // Map PolicyDecision to GovernanceCheck
    const allowed = decision.action === "allow";
    const blockedBy = allowed ? undefined : "policy";

    return {
      allowed,
      reason: decision.reason,
      blockedBy,
    };
  }

  /**
   * Check if an action is allowed by budget constraints.
   * Translates executor's checkBudget to budget engine evaluation.
   */
  async checkBudget(sessionId: string, _action: string): Promise<GovernanceCheck> {
    // Call budget engine with session scope
    // Note: action parameter is informational only - budget is session-scoped
    const evaluations = await evaluateBudget({ sessionId });

    // Check if any policy evaluation blocks
    const blockingEvaluation = evaluations.find(e => e.state === "block");

    if (blockingEvaluation) {
      return {
        allowed: false,
        reason: `Budget exceeded: ${blockingEvaluation.policyName}`,
        blockedBy: "budget",
      };
    }

    return {
      allowed: true,
    };
  }
}

// Export type for convenience
export type { GovernanceCheck };
