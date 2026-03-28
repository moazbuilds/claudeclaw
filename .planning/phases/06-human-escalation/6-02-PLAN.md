---
phase: 6
plan: 02
type: execute
name: Wire Escalation Integration
objective: Wire pause checks and escalation triggers into gateway and orchestrator
description: Connect built-but-unwired escalation functions to actual execution paths
tags: [gap-closure, integration, escalation]
wave: 1
estimated_duration: 1h
autonomous: true
gap_closure: true
gap_closure_reason: "Audit found escalation modules built but not wired - pause checks and triggers not called from gateway/orchestrator"
depends_on: ["6-01"]
files_modified:
  - src/gateway/index.ts
  - src/orchestrator/executor.ts
  - src/runner.ts
  - src/__tests__/integration/escalation-wiring.test.ts

must_haves:
  - gateway calls shouldBlockAdmission() before processing events
  - orchestrator calls shouldBlockScheduling() before executing tasks
  - watchdog triggers call handleWatchdogTrigger() from escalation
  - workflow failures call handleOrchestrationFailure() from escalation
  - integration tests verify pause blocks events
  - integration tests verify escalation notifications fire on triggers
---

# Phase 6 Gap Closure: Wire Escalation Integration

## Problem

Phase 6 built the escalation module with comprehensive pause/resume, handoff, notifications, and triggers - all with passing tests. But the integration audit found these functions are **exported but never called**:

| Function | Exported | Called |
|----------|----------|--------|
| `shouldBlockAdmission()` | ✅ | ❌ |
| `shouldBlockScheduling()` | ✅ | ❌ |
| `handleWatchdogTrigger()` | ✅ | ❌ |
| `handleOrchestrationFailure()` | ✅ | ❌ |
| `handlePolicyDenial()` | ✅ | ❌ |
| `handleDlqOverflow()` | ✅ | ❌ |

**Impact:** Operators cannot actually pause the daemon. Escalation notifications never fire. Handoffs don't auto-trigger.

---

## Tasks

### Task 1: Wire pause check into Gateway

<files>
src/gateway/index.ts
</files>

<action>
In `gateway/index.ts`, add pause admission check before processing events.

**Where to add:** In `processInboundEvent()` method, after checking `!this.running` and validation, but before getting session mapping:

```typescript
// Step 1.5: Check if system is paused (admission control)
if (shouldBlockAdmission()) {
  return { 
    success: false, 
    error: "System is paused - new events are not being admitted" 
  };
}
```

**Also update** the standalone `processInboundEvent()` function (line 265+) to call `shouldBlockAdmission()` before creating/getting gateway.

**Also update** `processEventWithFallback()` to check pause before routing to gateway.

Import `shouldBlockAdmission` from `"../escalation"` at the top of the file.

**Important:** Use async/await since `shouldBlockAdmission()` returns a Promise<boolean>.
</action>

<verify>
`grep -n "shouldBlockAdmission" src/gateway/index.ts` shows at least 2 calls
`bun test src/__tests__/escalation/pause.test.ts` - existing pause tests still pass
</verify>

<done>
Gateway rejects events with "System is paused" when pause is active
</done>

---

### Task 2: Wire pause check into Orchestrator

<files>
src/orchestrator/executor.ts
</files>

<action>
In `orchestrator/executor.ts`, add scheduling pause check before executing tasks.

**Where to add:** In `executeReadyTasks()`, after loading state and definition, before getting ready tasks:

```typescript
// Check if scheduling is blocked due to pause
if (shouldBlockScheduling()) {
  // Return current state without executing tasks - system is paused for scheduling
  return rebuiltState;
}
```

**Also add** in `executeWorkflow()` after loading state but before marking as running:

```typescript
// Check pause state before starting workflow
if (shouldBlockScheduling()) {
  return state; // Don't start new workflows when scheduling is paused
}
```

Import `shouldBlockScheduling` from `"../escalation"` at the top.

**Important:** Use async/await. This check prevents NEW tasks from being started but allows running tasks to complete (following admission_and_scheduling mode semantics).
</action>

<verify>
`grep -n "shouldBlockScheduling" src/orchestrator/executor.ts` shows at least 2 calls
`bun test src/__tests__/escalation/pause.test.ts` - existing pause tests still pass
</verify>

<done>
Orchestrator doesn't start new tasks when scheduling is paused
</done>

---

### Task 3: Wire watchdog escalation trigger

<files>
src/runner.ts
src/escalation/triggers.ts
</files>

<action>
In `runner.ts`, add escalation notification when watchdog triggers kill or suspend.

**Where to add:** After existing `watchdogHandleTrigger()` call at line 512 and line 568, add escalation notification:

```typescript
// After existing watchdogHandleTrigger call (line 512):
await watchdogHandleTrigger({ invocationId, sessionId: invocationSessionId }, watchdogDecision);

// Add escalation notification for watchdog triggers
if (watchdogDecision.state === "kill" || watchdogDecision.state === "suspend") {
  try {
    const { handleWatchdogTrigger } = await import("./escalation");
    await handleWatchdogTrigger(watchdogDecision, { invocationId });
  } catch (escalationError) {
    // Don't let escalation failure affect execution
    console.error("[escalation] Failed to send watchdog notification:", escalationError);
  }
}
```

**Import** at top of file is already dynamic (`await import("./escalation")`), so no static import needed.

**Note:** Use dynamic import to avoid circular dependency issues. Handle gracefully - escalation failure should not affect execution flow.
</action>

<verify>
`grep -n "handleWatchdogTrigger" src/runner.ts` shows calls after watchdog triggers
`bun test src/__tests__/escalation/triggers.test.ts` - existing trigger tests pass
</verify>

<done>
Watchdog kill/suspend events create escalation notifications
</done>

---

### Task 4: Wire orchestration failure trigger

<files>
src/orchestrator/executor.ts
</files>

<action>
In `orchestrator/executor.ts`, add escalation notification when workflow fails.

**Where to add:** In `executeTask()` when a task fails with an error, call escalation:

```typescript
// In executeTask() catch block, after returning failure:
if (!handler) {
  return {
    success: false,
    error: { type: "HandlerNotFound", message: `No handler registered for action: ${task.actionRef}` }
  };
}

// After the try/catch block returns, the caller (executeReadyTasks) handles advancement
```

Actually, better location: In `executeReadyTasks()`, when a task fails and advances the workflow, check if the workflow has failed and call escalation:

Add to the task execution loop after `currentState = advanceWorkflow(...)`:

```typescript
// Check if workflow reached failed state
if (result.error && currentState.status === "failed") {
  try {
    const { handleOrchestrationFailure } = await import("../escalation");
    await handleOrchestrationFailure(currentState.workflowId, result.error.message);
  } catch (escalationError) {
    console.error("[escalation] Failed to send orchestration failure notification:", escalationError);
  }
}
```

Import `handleOrchestrationFailure` from `"../escalation"` (add to existing import from escalation module at top).

**Important:** Use dynamic import or ensure escalation module is initialized before executor runs. Handle gracefully - escalation failure should not affect workflow state.
</action>

<verify>
`grep -n "handleOrchestrationFailure" src/orchestrator/executor.ts` shows call on workflow failure
`bun test src/__tests__/escalation/triggers.test.ts` - existing trigger tests pass
</verify>

<done>
Workflow failures create escalation notifications/handoffs
</done>

---

### Task 5: Add integration tests for pause wiring

<files>
src/__tests__/integration/escalation-wiring.test.ts
</files>

<action>
Create integration test file that verifies escalation is wired correctly:

```typescript
/**
 * Escalation Wiring Integration Tests
 * 
 * Verifies that escalation module functions are properly called
 * from gateway and orchestrator.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";

describe("Escalation Wiring Integration", () => {
  
  describe("Gateway pause check", () => {
    it("should reject events when system is paused", async () => {
      // Import gateway and escalation
      const { pause, shouldBlockAdmission } = await import("../escalation");
      const { processInboundEvent } = await import("../gateway/index");
      
      // Initially not paused
      expect(await shouldBlockAdmission()).toBe(false);
      
      // Pause the system
      await pause("admission_only", { reason: "Test pause", pausedBy: "test" });
      
      // Now admission should be blocked
      expect(await shouldBlockAdmission()).toBe(true);
      
      // Try to process event - should be rejected
      const event = createTestNormalizedEvent();
      const result = await processInboundEvent(event);
      expect(result.success).toBe(false);
      expect(result.error).toContain("paused");
    });
  });
  
  describe("Orchestrator scheduling check", () => {
    it("should not start new workflows when scheduling is paused", async () => {
      const { pause, shouldBlockScheduling } = await import("../escalation");
      const { executeWorkflow } = await import("../orchestrator/executor");
      
      // Pause with admission_and_scheduling mode
      await pause("admission_and_scheduling", { reason: "Test pause", pausedBy: "test" });
      
      expect(await shouldBlockScheduling()).toBe(true);
      
      // Workflow should not execute
      // Note: depends on having a test workflow available
    });
  });
});

function createTestNormalizedEvent() {
  return {
    channel: "test",
    channelId: "test:123",
    threadId: "test-thread-1",
    actor: { id: "test-user", name: "Test User" },
    content: "test message",
    timestamp: new Date().toISOString(),
  };
}
```

**Location:** Create `src/__tests__/integration/escalation-wiring.test.ts`

**Note:** This is a sketch - adjust based on actual gateway/orchestrator initialization patterns in the codebase.
</action>

<verify>
`bun test src/__tests__/integration/escalation-wiring.test.ts` - tests pass
</verify>

<done>
Integration tests verify pause blocks gateway events
</done>

---

## Wiring Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BEFORE (unwired)                             │
├─────────────────────────────────────────────────────────────────────┤
│  Gateway ──────────────────► [processes events]                     │
│  Orchestrator ─────────────► [executes tasks]                       │
│  Runner ───────────────────► [watches dog] ──► kill/suspend        │
│  Executor ─────────────────► [runs workflow] ──► failure            │
│                                                                     │
│  ESCALATION MODULE: isolated, never called                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         AFTER (wired)                               │
├─────────────────────────────────────────────────────────────────────┤
│  Gateway                                                            │
│    └─► shouldBlockAdmission() ──► reject if paused                 │
│                                                                     │
│  Orchestrator Executor                                              │
│    └─► shouldBlockScheduling() ──► skip tasks if paused             │
│                                                                     │
│  Runner                                                             │
│    └─► watchdog kill/suspend ──► handleWatchdogTrigger() ──► notify │
│                                                                     │
│  Executor                                                           │
│    └─► workflow failure ──► handleOrchestrationFailure() ──► notify│
└─────────────────────────────────────────────────────────────────────┘
```

---

## Verification

Run all escalation tests to confirm nothing broke:

```bash
bun test src/__tests__/escalation/
bun test src/__tests__/integration/escalation-wiring.test.ts
```

Run full test suite to confirm integration:

```bash
bun test
```

---

## Success Criteria

1. ✅ `shouldBlockAdmission()` called in gateway before event processing
2. ✅ `shouldBlockScheduling()` called in orchestrator before task execution
3. ✅ `handleWatchdogTrigger()` called when watchdog triggers kill/suspend
4. ✅ `handleOrchestrationFailure()` called when workflow task fails
5. ✅ Integration tests verify pause actually blocks gateway admission
6. ✅ All 346+ existing tests still pass
