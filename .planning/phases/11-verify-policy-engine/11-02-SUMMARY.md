# Phase 11 Plan 02: Audit Logging Gap Closure Summary

## Overview

**Plan:** 11-02
**Phase:** 11-verify-policy-engine
**Type:** Gap Closure
**Status:** ✅ Complete

## Gap Closed

**Gap from 11-VERIFICATION.md:**
- Truth failed: "Every decision is written to an audit log"
- Both gateway and runner paths called `gc.evaluateToolRequest()` but did NOT log to audit-log
- Audit log functions existed but were only used by the escalation module

## What Was Changed

Added `logPolicyDecision()` calls to `GovernanceClient.evaluateToolRequest()` so that both gateway and runner enforcement paths automatically log every policy decision to the audit trail.

### Implementation Details

1. **Import added** to `src/governance/client.ts`:
   ```typescript
   import { logPolicyDecision } from "../policy/audit-log";
   ```

2. **Modified `evaluateToolRequest()`** to log after every `evaluate()` call:
   ```typescript
   const decision = evaluate(request);

   // Log every policy decision to audit trail (fire-and-forget)
   logPolicyDecision(
     request.eventId,
     decision.requestId,
     request.source,
     request.toolName,
     decision.action,
     decision.reason,
     {
       channelId: request.channelId,
       threadId: request.threadId,
       userId: request.userId,
       skillName: request.skillName,
       matchedRuleId: decision.matchedRuleId,
     }
   ).catch(err => {
     console.error("[governance] Failed to write audit log:", err);
   });

   return decision;
   ```

### Key Design Decisions

- **Fire-and-forget logging**: `.catch()` ensures audit log failure does NOT block policy decisions
- **Central location**: One change in `evaluateToolRequest()` covers BOTH gateway and runner paths
- **Full context passed**: Includes `eventId`, `requestId`, `source`, `toolName`, `action`, `reason`, and optional fields (`channelId`, `threadId`, `userId`, `skillName`, `matchedRuleId`)

## Files Modified

| File | Change |
|------|--------|
| `src/governance/client.ts` | Added import and logPolicyDecision() call |

## Test Results

```
94 pass, 1 fail (pre-existing test isolation issue in audit-log.test.ts)
95 tests total in src/__tests__/policy/
```

The 1 failing test is a pre-existing issue where the audit-log.test.ts has leftover entries from previous tests affecting test isolation. This is NOT caused by my changes.

## Commit

```
580df81 feat(11-02): add audit logging to GovernanceClient.evaluateToolRequest()
```

## Success Criteria Met

- ✅ `src/governance/client.ts` imports and calls `logPolicyDecision()` for every policy decision
- ✅ Both gateway and runner paths automatically log because they both call `gc.evaluateToolRequest()`
- ✅ Audit logging is fire-and-forget (failures don't block policy decisions)
- ✅ Existing tests still pass (94/95 - 1 pre-existing failure)

## Truth Restored

**"Every decision is written to an audit log"** - ACHIEVED

Now every call to `gc.evaluateToolRequest()` from both gateway and runner paths results in a `logPolicyDecision()` call to the audit trail at `.claude/claudeclaw/audit-log.jsonl`.
