---
phase: 4
name: Cost & Model Governance
description: Durable usage accounting, budget-aware routing, and watchdog controls for safe model execution
objective: Implement persisted usage tracking, policy-driven model selection, budget enforcement, and runaway execution protection aligned with the event bus, gateway, and policy engine
---

# Phase 4: Cost & Model Governance

## Goal
Implement durable usage accounting, budget-aware model routing, and watchdog protections for model execution.

This phase adds operational control over:
- token and cost accounting
- budget enforcement
- model/provider selection
- runaway execution detection
- governance telemetry

It must integrate cleanly with the Phase 1 event bus, Phase 2 gateway/session model, and Phase 3 policy engine.

## Why This Matters

### Current state
- Cost tracking is missing or too ad hoc.
- Model routing is too naive or too static.
- Budget enforcement is weak or absent.
- There is no durable governance state for usage and spend.
- Long-running or looping agents are not reliably detected and controlled.

### Target state
- Usage is durably recorded per invocation, session, channel, and model/provider.
- Cost is computed from configurable pricing metadata and clearly labeled as estimated.
- Model selection is policy-driven and budget-aware.
- Budget thresholds can warn, degrade, block, or reroute execution.
- Runaway execution is detected deterministically and handled through the control plane, not by ad hoc subprocess hacks.
- Usage and governance telemetry are available to the dashboard/API without becoming a separate source of truth.

## Non-goals for Phase 4
Do **not** implement:
- provider-specific billing reconciliation beyond best-effort estimated cost accounting
- a full billing UI
- broad orchestration controls unrelated to model/cost governance
- human takeover workflow beyond watchdog/operator notification hooks
- fake support for providers that are not already integrated cleanly

This phase is specifically about **usage accounting, routing, budgets, and runaway protection**.

## Success Criteria
- every model invocation records durable usage metadata when available
- usage is attributable per invocation, session, channel, source, and model/provider
- cost calculations are clearly marked as estimated and configurable
- model selection is policy-driven and budget-aware, not keyword-only
- budget enforcement supports warning, degrade, block, or reroute behavior
- watchdog detects runaway execution using durable execution metrics
- watchdog actions integrate with event/policy flow and do not create hidden side channels
- telemetry API/dashboard reflects persisted governance state
- tests cover accounting, routing, budget thresholds, watchdog logic, restart recovery, and telemetry

## Prerequisites
- Phase 1 (Persistent Event Bus) complete
- Phase 2 (Session Gateway) complete
- Phase 3 (Policy Engine) complete
- all previous tests passing

## Core design constraints
- persisted state is the source of truth
- accounting must be per invocation first, with aggregates derived from persisted records
- estimated cost must never be presented as exact provider billing
- routing decisions must be reproducible/auditable from input context and current policy/budget state
- watchdog state must survive restart where operationally necessary
- watchdog actions must flow through governance/event/policy paths rather than bypass them
- telemetry may cache aggregates, but cached telemetry must not become canonical state

## Governance model

### Invocation usage record
Usage accounting should operate on durable per-invocation records similar to:

```ts
interface InvocationUsageRecord {
  invocationId: string;
  eventId?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
  source?: string;
  channelId?: string;
  threadId?: string;
  provider: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  status: "started" | "completed" | "failed" | "killed";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  estimatedCost?: {
    currency: string;
    inputCost?: number;
    outputCost?: number;
    cacheCost?: number;
    totalCost?: number;
    pricingVersion?: string;
  };
  metadata?: Record<string, unknown>;
  error?: {
    type?: string;
    message: string;
  };
}
```

### Budget model
```ts
interface BudgetPolicy {
  id: string;
  scope: {
    source?: string | string[];
    channelId?: string | string[];
    userId?: string | string[];
    sessionId?: string | string[];
    model?: string | string[];
    provider?: string | string[];
  };
  thresholds: {
    warnAt?: number;
    degradeAt?: number;
    rerouteAt?: number;
    blockAt?: number;
  };
  period: "session" | "daily" | "monthly";
  currency: string;
  actionDefaults?: {
    degradeToModel?: string;
    rerouteToProvider?: string;
  };
}
```

### Routing decision model
```ts
interface ModelRoutingDecision {
  requestId: string;
  selectedProvider: string;
  selectedModel: string;
  reason: string;
  matchedPolicyId?: string;
  budgetState?: "healthy" | "warn" | "degrade" | "reroute" | "block";
  fallbackChain?: Array<{ provider: string; model: string }>;
  decidedAt: string;
}
```

## Tasks

### D.1 — Usage Tracker
- **File:** `src/governance/usage-tracker.ts`
- **Status:** TODO
- **Prerequisites:** Phase 1 event persistence, Phase 2 session mapping

#### Goal
Capture durable per-invocation usage/accounting records and expose aggregate queries.

#### Done When
- [ ] usage record format is defined and documented
- [ ] per-invocation records stored durably under `.claude/claudeclaw/usage/`
- [ ] usage parsing supports known provider response shapes where available
- [ ] missing usage blocks are handled explicitly and safely
- [ ] usage is attributable by invocation, session, channel, source, provider, and model
- [ ] cost is computed from configurable pricing metadata and labeled as estimated
- [ ] API includes:
  - `recordInvocationStart(context)`
  - `recordInvocationCompletion(context, usage)`
  - `recordInvocationFailure(context, error)`
  - `getInvocation(invocationId)`
  - `getSessionUsage(sessionId)`
  - `getChannelUsage(channelId)`
  - `getAggregates(filters)`

#### Important Notes
- do not store only aggregate totals; aggregates must be derived from durable invocation records
- do not treat provider usage blocks as perfectly stable; parsing must be version-tolerant and documented
- cost rates must be configurable and versioned

#### Tests
- usage record persists correctly
- repeated updates for same invocation remain idempotent
- aggregate totals derive correctly from invocation records
- missing/partial usage block does not corrupt accounting

---

### D.2 — Pricing & Budget Engine
- **File:** `src/governance/budget-engine.ts`
- **Status:** TODO
- **Prerequisites:** D.1, Phase 3 policy foundations

#### Goal
Evaluate current spend/usage against configured budget policies and return governance actions.

#### Done When
- [ ] pricing metadata stored in config with versioning
- [ ] budget policies support session, daily, and monthly scopes
- [ ] budget evaluation returns one of:
  - `healthy`
  - `warn`
  - `degrade`
  - `reroute`
  - `block`
- [ ] thresholds and actions are explicit and testable
- [ ] API includes:
  - `evaluateBudget(context): BudgetEvaluation`
  - `getBudgetState(scope): BudgetState`
  - `loadPricing()`
  - `loadBudgetPolicies()`
- [ ] budget calculations are restart-safe because they derive from persisted usage state
- [ ] warnings and threshold crossings can emit governance events/audit records

#### Important Notes
- do not hard-code “monthlyLimit/perSessionLimit” per model as the only budget mechanism
- budgets should be policy-driven and scoped
- cost accounting must be clearly labeled estimated
- budget evaluation should integrate with policy engine concepts where appropriate

#### Tests
- threshold transitions are correct
- budget state derives correctly after restart
- degrade/reroute/block actions are returned at expected thresholds
- pricing version changes are handled safely

---

### D.3 — Model Router
- **File:** `src/governance/model-router.ts`
- **Status:** TODO
- **Prerequisites:** D.1, D.2, Phase 3 policy engine

#### Goal
Select provider/model combinations using policy, task context, capability requirements, and budget state.

#### Done When
- [ ] router accepts normalized request context rather than keyword-only inputs
- [ ] routing considers:
  - task type / capability needs
  - explicit user or task override when permitted
  - budget state
  - policy restrictions
  - provider/model availability
- [ ] router returns auditable routing decisions with reason and fallback chain
- [ ] supports degradation/rerouting to cheaper models/providers when policy/budget state requires it
- [ ] supports deny/block outcomes when execution is not permitted
- [ ] API includes:
  - `selectModel(requestContext): ModelRoutingDecision`
  - `getFallbackChain(requestContext)`
- [ ] existing router behavior is either wrapped or cleanly replaced without dual sources of truth

#### Important Notes
- do not describe routing as “naive keyword-based” in the new implementation; that is what we are replacing
- routing decisions must be auditable and reproducible
- fallback chains must not silently violate Phase 3 tool/policy constraints

#### Tests
- healthy budget selects preferred model
- degrade state selects cheaper allowed model
- reroute state selects alternate provider/model when configured
- block state prevents selection cleanly
- explicit override is rejected when policy disallows it

---

### D.4 — Runaway Watchdog
- **File:** `src/governance/watchdog.ts`
- **Status:** TODO
- **Prerequisites:** D.1, Phase 1 event/state foundation

#### Goal
Detect and control runaway execution patterns safely and durably.

#### Done When
- [ ] watchdog monitors durable execution metrics per invocation/session
- [ ] tracked metrics include at minimum:
  - tool call count
  - turn count
  - repeated identical/similar tool calls
  - elapsed runtime
- [ ] thresholds are configurable and documented
- [ ] watchdog decisions can return:
  - `healthy`
  - `warn`
  - `suspend`
  - `kill`
- [ ] watchdog actions generate governance/audit events
- [ ] if process termination support exists, it is invoked through a controlled execution abstraction
- [ ] if hard kill is not yet safely implemented, return a clear, tested skeleton that does not pretend to do more than it does
- [ ] API includes:
  - `recordExecutionMetric(context)`
  - `checkLimits(context): WatchdogDecision`
  - `handleTrigger(context, decision)`

#### Important Notes
- do not make subprocess killing the core design
- watchdog must integrate with event/governance/audit flow
- “kill” should be modeled as a governance outcome first, then mapped to execution control if supported
- repeated-tool detection must use normalized tool signatures, not brittle raw string comparisons

#### Tests
- excessive tool calls trigger watchdog
- repeated identical tool patterns trigger watchdog
- restart-safe state reconstruction works where applicable
- skeleton kill path is clearly bounded and audited

---

### D.5 — Governance Telemetry
- **File:** `src/governance/telemetry.ts`
- **Status:** TODO
- **Prerequisites:** D.1, D.2, D.4

#### Goal
Expose persisted governance state and derived aggregates to API/dashboard consumers.

#### Done When
- [ ] telemetry derives from persisted usage/governance records
- [ ] endpoint or service contract is documented clearly
- [ ] response includes at minimum:
  - total sessions
  - active sessions
  - estimated total cost
  - usage by channel/source
  - usage by model/provider
  - current budget state summaries
  - watchdog trigger summaries
- [ ] telemetry supports filtered queries where practical
- [ ] SSE/real-time updates are optional and only added if current dashboard architecture supports them cleanly

#### Example response shape
```ts
interface GovernanceTelemetry {
  totalSessions: number;
  activeSessions: number;
  estimatedTotalCost: number;
  currency: string;
  channelStats: Record<string, { sessions: number; estimatedCost: number; tokens: number }>;
  providerStats: Record<string, { calls: number; tokens: number; estimatedCost: number }>;
  modelStats: Record<string, { calls: number; tokens: number; estimatedCost: number }>;
  budgetStates: Record<string, { status: string; scope: string }>;
  watchdog: { triggered: number; warned: number; killed: number; suspended: number };
}
```

#### Important Notes
- telemetry is read-side only
- telemetry caches may exist, but persisted usage/governance records remain canonical
- do not force SSE if the dashboard/server layer does not already support it sanely

#### Tests
- telemetry aggregates reflect persisted state
- filtered query returns expected subset
- absent optional data does not break response schema

## Integration Points

### With Phase 1 & 2
- **event log / processor:** governance events and usage records tie back to durable event/invocation flow
- **session map:** usage and budgets attribute correctly to local session identity and channel/source context
- **gateway:** requests pass through routing/budget evaluation before execution

### With Phase 3
- **policy engine:** model overrides and routing decisions must respect policy constraints
- **audit log / approval flow:** threshold crossings, blocks, reroutes, and watchdog actions should be auditable

### With existing execution path
- **runner.ts** should report invocation start/completion/failure and usage metadata
- **existing model-router.ts** should be wrapped or replaced by the governance-aware router, not duplicated
- **ui/server.ts** may expose telemetry if the current server architecture supports it cleanly

### Future phases
- escalation/human takeover can build on watchdog triggers and budget block/reroute events
- orchestration can use governance signals for task planning and throttling

## Cost Calculation

### Pricing model
- pricing must be configurable and versioned
- calculations must be labeled **estimated**
- provider-specific fields should be mapped into a normalized usage shape before cost calculation

### Example pricing table
| Provider | Model | Input / 1M | Output / 1M | Cache Read / 1M | Cache Create / 1M |
|----------|-------|------------|-------------|------------------|-------------------|
| anthropic | claude-3-5-sonnet | configurable | configurable | configurable | configurable |
| anthropic | claude-3-haiku | configurable | configurable | configurable | configurable |
| glm | glm-4 | configurable | configurable | N/A | N/A |

### Example formula
`estimatedCost = ((inputTokens * inputRate) + (outputTokens * outputRate) + (cacheReadTokens * cacheReadRate) + (cacheCreateTokens * cacheCreateRate)) / 1_000_000`

## Test Strategy

### Unit tests
- usage parsing and record persistence
- aggregate derivation
- budget threshold evaluation
- routing decision logic
- watchdog limit checks
- telemetry aggregation

### Integration tests
- invocation -> usage record -> budget evaluation -> routing decision
- threshold crossing emits expected governance behavior
- watchdog trigger produces auditable control-plane action
- telemetry reflects persisted records after restart

### Correctness / safety tests
- repeated accounting updates remain idempotent
- missing usage blocks do not break governance state
- block/reroute decisions do not bypass policy engine constraints
- watchdog action does not silently kill without audit/control-plane record

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Cost calculation differs from provider billing | Label clearly as estimated; use versioned configurable pricing |
| Usage parsing breaks on provider schema drift | Normalize provider responses defensively and test partial/missing fields |
| Budget enforcement too aggressive | Explicit threshold states (warn/degrade/reroute/block) and clear policy config |
| Routing becomes opaque | Return auditable routing decisions with reason and matched policy/budget state |
| Watchdog false positives | Configurable thresholds, normalized metrics, operator review hooks |
| Governance state drift | Persist per-invocation state and derive aggregates from it |
| Duplicate router implementations | Wrap/replace existing router cleanly; avoid dual routing sources |

## Dependencies
- Phase 1 event/state foundation
- Phase 2 session mapping / normalized request context
- Phase 3 policy engine and audit primitives
- existing provider invocation path in runner/execution layer

## Expected Output
- `src/governance/usage-tracker.ts`
- `src/governance/budget-engine.ts`
- `src/governance/model-router.ts`
- `src/governance/watchdog.ts`
- `src/governance/telemetry.ts`
- `src/__tests__/governance/usage-tracker.test.ts`
- `src/__tests__/governance/budget-engine.test.ts`
- `src/__tests__/governance/model-router.test.ts`
- `src/__tests__/governance/watchdog.test.ts`
- `src/__tests__/governance/telemetry.test.ts`
- supporting docs describing pricing, budget thresholds, routing semantics, and watchdog behavior

## Checkpoint
Before Phase 5 begins:
1. run all tests: `bun test`
2. verify estimated usage/cost accounting on representative invocations
3. test warn/degrade/reroute/block budget thresholds
4. verify router decisions are auditable and policy-compliant
5. verify watchdog triggers and resulting governance/audit behavior
6. verify telemetry output against persisted governance state
7. approve Phase 5 start
