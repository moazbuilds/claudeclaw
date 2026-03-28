---
phase: 6
plan: 02
name: Wire Escalation Integration
subsystem: escalation
tags: [escalation, gateway, orchestrator, watchdog, wiring, integration]
dependency-graph:
  requires: [phase-6-plan-01]
  provides: [escalation-wired]
  affects: [gateway, orchestrator, runner]
tech-stack:
  patterns:
    - Dynamic imports for escalation module (avoid circular deps)
    - Async/await error handling with try/catch around escalation calls
    - Graceful degradation if escalation fails (log error, continue)
key-files:
  created:
    - src/__tests__/integration/escalation-wiring.test.ts
  modified:
    - src/gateway/index.ts - Added shouldBlockAdmission() checks
    - src/orchestrator/executor.ts - Added shouldBlockScheduling() and handleOrchestrationFailure()
    - src/runner.ts - Added handleWatchdogTrigger() call
decisions:
  - "Dynamic imports for escalation module to avoid circular dependencies"
  - "Graceful degradation: log escalation errors but continue execution"
  - "Pause checks use async shouldBlockAdmission()/shouldBlockScheduling()"
  - "Escalation notifications fire for watchdog kill/suspend states"
metrics:
  duration: "45m"
  completed_date: "2026-03-28"
  total_tasks: 5
  completed_tasks: 5
  total_tests: 15
  passing_tests: 15
---

# Phase 6 Plan 02: Wire Escalation Integration Summary

## Overview

Closed the gap identified in the Phase 6 audit: escalation modules were built but not wired into the system. This plan connects the escalation functions to their call sites in gateway, orchestrator, and runner.

## What Was Wired

### Task 1: Gateway Pause Check

**File:** `src/gateway/index.ts`

Added `shouldBlockAdmission()` calls at three locations:

1. `Gateway.processInboundEvent()` method - after validation, before session mapping
2. Standalone `processInboundEvent()` function - before gateway creation
3. `processEventWithFallback()` function - before routing decision

```typescript
if (await shouldBlockAdmission()) {
  return { success: false, error: "System is paused - new events are not being admitted" };
}
```

### Task 2: Orchestrator Pause Check

**File:** `src/orchestrator/executor.ts`

Added `shouldBlockScheduling()` checks at two locations:

1. `executeReadyTasks()` - after rebuilding state, before getting ready tasks
2. `executeWorkflow()` - after loading state, before marking as running

```typescript
if (await shouldBlockScheduling()) {
  return rebuiltState; // Skip task execution
}
```

### Task 3: Watchdog Escalation Trigger

**File:** `src/runner.ts`

Added `handleWatchdogTrigger()` call after existing `watchdogHandleTrigger()` when watchdog decision is kill or suspend:

```typescript
if (watchdogDecision.state === "suspend" || watchdogDecision.state === "kill") {
  try {
    const { handleWatchdogTrigger } = await import("./escalation");
    await handleWatchdogTrigger(watchdogDecision, { invocationId, sessionId: invocationSessionId });
  } catch (escalationError) {
    console.error("[escalation] Failed to send watchdog notification:", escalationError);
  }
}
```

### Task 4: Orchestration Failure Trigger

**File:** `src/orchestrator/executor.ts`

Added `handleOrchestrationFailure()` call in `executeReadyTasks()` after `advanceWorkflow()` when task fails:

```typescript
if (result.error && currentState.status === "failed") {
  try {
    const { handleOrchestrationFailure } = await import("../escalation");
    await handleOrchestrationFailure(currentState.workflowId, result.error.message);
  } catch (escalationError) {
    console.error("[escalation] Failed to send orchestration failure notification:", escalationError);
  }
}
```

### Task 5: Integration Tests

**File:** `src/__tests__/integration/escalation-wiring.test.ts`

Created 15 integration tests covering:

- Gateway rejects events when paused (admission_only mode)
- Gateway rejects events when paused (admission_and_scheduling mode)
- Gateway accepts events when not paused
- Standalone `processInboundEvent()` checks pause state
- `processEventWithFallback()` checks pause state and doesn't call legacy handler when paused
- Orchestrator skips task execution when scheduling paused
- Orchestrator allows execution when only admission paused
- Watchdog trigger handling for suspend and kill states
- Auto-pause triggered on watchdog kill
- Full pause/resume lifecycle
- Failure count tracking

## Test Results

| Test Suite | Pass | Fail |
|------------|------|------|
| Escalation (existing) | 129 | 0 |
| Integration (new) | 15 | 0 |
| Orchestrator (existing) | 83 | 0 |
| Gateway (existing) | 127 | 0 |

**Total:** 354 tests passing

## Verification Commands

```bash
# Verify shouldBlockAdmission calls in gateway
grep -n "shouldBlockAdmission" src/gateway/index.ts

# Verify shouldBlockScheduling calls in orchestrator
grep -n "shouldBlockScheduling" src/orchestrator/executor.ts

# Verify handleWatchdogTrigger in runner
grep -n "handleWatchdogTrigger" src/runner.ts

# Verify handleOrchestrationFailure in executor
grep -n "handleOrchestrationFailure" src/orchestrator/executor.ts

# Run escalation tests
bun test src/__tests__/escalation/

# Run integration tests
bun test src/__tests__/integration/escalation-wiring.test.ts
```

## Deviations from Plan

None - all tasks executed as specified.

## Auth Gates

None - no authentication required for this plan.

## Impact

- **Operators can now actually pause the daemon** - gateway and orchestrator respect pause state
- **Escalation notifications fire on triggers** - watchdog and orchestration failures now generate notifications
- **System behavior is consistent** - pause applies to both admission and scheduling in full pause mode
