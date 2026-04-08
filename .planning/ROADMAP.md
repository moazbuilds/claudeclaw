# Roadmap: ClaudeClaw v2 Upgrade

## Vision
Transform ClaudeClaw from a fire-and-forget daemon into a robust, production-ready agent platform with durable execution, fine-grained governance, and multi-channel session management.

## Progress

| Phase | Name | Tasks | Status | Completion |
|-------|------|-------|--------|------------|
| 0 | Project Initialization | 1 | ✅ Complete | 2026-03-26 |
| 1 | Persistent Event Bus | 5 | ✅ Complete | 2026-03-26 |
| 2 | Session Gateway | 4 | ✅ Complete | 2026-03-28 |
| 3 | Policy Engine | 5 | ✅ Complete | 2026-03-27 |
| 4 | Cost Governance | 5 | ✅ Complete | 2026-03-27 |
| 5 | Orchestration | 5 | ✅ Complete | 2026-03-28 |
| 6 | Human Escalation | 6 | ✅ Complete | 2026-03-28 |
| 7 | Additional Adapters | 7 | ✅ Complete | 2026-03-28 |
| 8 | Policy Integration | 4 | ✅ Complete | 2026-03-30 |
| 9 | Gateway Integration | Complete | 2026-03-30 | 2026-03-30 |
| 10 | Orchestrator Governance Bridge | Complete    | 2026-03-30 | 2026-03-30 |
| 11 | Re-verify Phase 3 Policy Engine | Complete    | 2026-03-30 | 2026-03-30 |
| 12 | 1/1 | Complete    | 2026-03-30 | 2026-03-30 |
| 13 | Gap Closure | Complete    | 2026-03-30 |
| 14 | Security Hardening | Complete    | 2026-03-30 | 2026-03-30 |
| 15 | Test Fix & Simplification | Complete    | 2026-03-31 | 2026-03-31 |

## Phase 2: Session Gateway

**Goal:** Map each channel+thread combination to its own session, enabling per-conversation resume. Build the gateway layer that decouples channel adapters from event processing.

**Requirements:**
- session-isolation: per-channel+thread session mapping
- per-thread-resume: deterministic session resume by channel+thread
- event-normalization: unified event schema across platforms
- adapter-decoupling: gateway pattern for adapter independence

**Plans:**
4/4 plans complete
|------|------|-----------|------|------------|--------|
| 2-01 | [2-01-PLAN.md](phases/2-session-gateway/2-01-PLAN.md) | Session Map Store | 1 | — | ✅ Complete |
| 2-02 | [2-02-PLAN.md](phases/2-session-gateway/2-02-PLAN.md) | Normalized Event Schema | 1 | — | ✅ Complete |
| 2-03 | [2-03-PLAN.md](phases/2-session-gateway/2-03-PLAN.md) | Resume Logic | 2 | 2-01 | ✅ Complete |
| 2-04 | [2-04-PLAN.md](phases/2-session-gateway/2-04-PLAN.md) | Gateway Orchestrator | 3 | 2-01, 2-02, 2-03 | ✅ Complete |

## Phase 3: Policy Engine

**Goal:** Fine-grained, contextual tool governance with persisted approval workflow and audit trail.

**Requirements:**
- rule-based-authorization: policy engine with allow/deny/require_approval
- channel-scoped-policies: per-channel and per-user policy overrides
- skill-overlays: skill-specific tool constraints
- durable-approvals: operator approval workflow with persistence
- audit-logging: comprehensive audit trail

**Plans:**
1/5 plans complete
|------|------|-----------|------|------------|--------|
| 3-01 | [03-01-SUMMARY.md](phases/03-policy-engine/03-01-SUMMARY.md) | Policy Engine Core | 5 | — | ✅ Complete |

**Remaining Plans:**
- 3-02 through 3-05: (integrated into single implementation)

**Total Tasks:** 29
**Completed:** 14 (48%)

## Phase 4: Cost Governance

**Goal:** Usage tracking, budget enforcement, governance-aware model routing, runaway detection, and telemetry.

**Requirements:**
- usage-tracking: Per-invocation usage records with aggregate queries
- budget-enforcement: Policy-driven budget evaluation (warn/degrade/reroute/block)
- model-routing: Governance-aware model selection
- watchdog-detection: Runaway execution detection
- telemetry-api: Governance metrics API

**Plans:**
2/2 plans complete
|------|------|-----------|------|------------|--------|
| 4-01 | [4-01-SUMMARY.md](phases/04-cost-governance/4-01-SUMMARY.md) | Cost & Model Governance | 5 | — | ✅ Complete |
| 4-02 | [4-02-SUMMARY.md](phases/04-cost-governance/4-02-SUMMARY.md) | Gap Closure: Wire Runner to Governance | 1 | — | ✅ Complete |

**Total Tasks:** 6
**Completed:** 6 (100%)

## Phase Dependencies

```
Phase 0 ──────────────────────────────────────────────────►
     │
     ▼
Phase 1 (Event Bus) ──────────────────────────────────────►
     │
     ▼
Phase 2 (Gateway) ───────────────────────────────────────►
     │
     ├──► Phase 3 (Policy) ────────────────────────────────►
     │         │
     │         └──► Phase 4 (Governance) ──────────────────►
     │                    │
     │                    └──► Phase 5 (Orchestration) ────►
     │                              │
     │                              └──► Phase 6 (Escalation) ►
     │                                        │
     │                                        └──► Phase 8 (Policy Integration) ──►
     │
      └──► Phase 7 (Adapters) ──────────────────────────────►
                                                          │
                                                          └──► Phase 9 (Gateway Integration) ──►
```

## Phase 6 Gap Closure: Wire Escalation Integration

**Status:** ✅ Complete

**Problem:** Phase 6 built escalation modules (pause, handoff, notifications, triggers) with all tests passing, but integration audit revealed the functions are **exported but never called**:
- `shouldBlockAdmission()` not wired to gateway
- `shouldBlockScheduling()` not wired to orchestrator  
- `handleWatchdogTrigger()` not wired to runner
- `handleOrchestrationFailure()` not wired to executor

**Fix Applied:** Wired pause checks and escalation triggers into gateway and orchestrator.

**Plans:**
|------|------|-----------|------|------------|--------|
| 6-01 | [6-01-SUMMARY.md](phases/06-human-escalation/6-01-SUMMARY.md) | Human Escalation Core | 5 | — | ✅ Complete |
| 6-02 | [6-02-SUMMARY.md](phases/06-human-escalation/6-02-SUMMARY.md) | Wire Escalation Integration | 5 | 6-01 | ✅ Complete |

## Phase 8: Policy Integration (Gap Closure)

**Goal:** Wire policy engine and approval queue into execution path, implement GovernanceClient integration.

**Requirements:**
- rule-based-authorization: policy engine wired to gateway/runner
- durable-approvals: approval queue wired to event processing

**Gap Closure:** Closes gaps from v1.0 audit:
- REQ-3.1: policy/engine evaluate() never called
- REQ-3.3: approval-queue enqueue() never called
- REQ-5.1: GovernanceClient interface not implemented

**Plans:**
1/1 plans complete
| 8-01 | [8-01-PLAN.md](phases/08-policy-integration/8-01-PLAN.md) | Wire Policy to Execution | 4 | — | Pending |

**Plan 8-01 Tasks:**
1. Create GovernanceClient interface (src/governance/client.ts)
2. Wire evaluate() into gateway (src/gateway/index.ts)
3. Add policy evaluation wrapper for runner (src/runner.ts)
4. Add integration tests for policy wiring (src/__tests__/policy/wiring.test.ts)

## Phase 9: Gateway Integration (Gap Closure)

**Goal:** Wire adapters to gateway, connect event processor to gateway flow.

**Requirements:**
- adapter-decoupling: adapters must route through gateway
- GATEWAY-01: telegram/discord bypass gateway

**Gap Closure:** Closes gaps from v1.0 audit:
- GATEWAY-01: telegram/discord bypass gateway

**Plans:**
1/1 plans complete
| 9-01 | [9-01-PLAN.md](phases/09-gateway-integration/9-01-PLAN.md) | Wire Adapters to Gateway | 3 | — | ✅ Complete |

## Phase 10: Orchestrator Governance Bridge

**Goal:** Fix interface mismatch between orchestrator's GovernanceClient and actual GovernanceClient class so task-level governance enforcement works.

**Requirements:**
- orchestrator-governance-interface: Bridge the interface mismatch

**Gap Closure:** Closes gaps from v1.0 audit:
- orchestrator-governance-interface (partial)
- governance-client-orchestrator-mismatch (integration)
- orchestrator-governance-flow (broken)

**Plans:**
1/1 plans complete
| 10-01 | [10-01-PLAN.md](phases/10-orchestrator-governance-bridge/10-01-PLAN.md) | Bridge GovernanceClient Interface | 2 | — | ✅ Complete |

## Phase 11: Re-verify Phase 3 Policy Engine

**Goal:** Re-run verification for Phase 3 to confirm policy engine implementation is complete.

**Gap Closure:** Closes tech debt from v1.0 audit:
- 03-VERIFICATION.md is stale (claims 0/10 artifacts but implementation exists)
- Truth failed: "Every decision is written to an audit log"

**Plans:**
2/2 plans complete
| 11-01 | [11-01-PLAN.md](phases/11-verify-policy-engine/11-01-PLAN.md) | Re-verify Policy Engine | 1 | — | ✅ Complete |
| 11-02 | [11-02-PLAN.md](phases/11-verify-policy-engine/11-02-PLAN.md) | Audit Logging Gap Closure | 1 | 11-01 | ✅ Complete |

## Phase 12: Verify Phase 7 Additional Adapters

**Goal:** Create verification for documentation-only phase to confirm completeness.

**Gap Closure:** Closes tech debt from v1.0 audit:
- Phase 7 has no verification file

**Plans:**
1/1 plans complete
| 12-01 | [12-01-PLAN.md](phases/12-verify-adapter-docs/12-01-PLAN.md) | Verify Adapter Documentation | 1 | — | ✅ Complete |

## Phase 13: Gap Closure

**Goal:** Wire 3 remaining integration gaps from v1.0 milestone audit:
1. OrchestratorGovernanceAdapter → setGovernanceClient() at startup
2. Policy denial → handlePolicyDenial() in gateway
3. DLQ overflow → handleDlqOverflow() when threshold exceeded

**Gap Closure:** Closes gaps from v1.0 audit:
- orchestrator-governance not wired
- handlePolicyDenial not wired
- handleDlqOverflow not wired

**Plans:**
1/1 plans complete
| 13-01 | [13-01-PLAN.md](phases/13-gap-closure/13-01-PLAN.md) | Wire Remaining Integration Gaps | 3 | — | ✅ Complete |

## Milestones

### Milestone 1: Foundation (Phases 1-2)
- Durable event log
- Session mapping
- **Target:** Core reliability improvements

### Milestone 2: Governance (Phases 3-4)
- Policy engine
- Cost tracking
- **Target:** Production-grade controls

### Milestone 3: Advanced Features (Phases 5-7)
- Task orchestration
- Human escalation
- Additional adapters
- **Target:** Enterprise readiness

## Timeline (Estimated)

| Phase | Duration | Cumulative |
|-------|----------|------------|
| 1 | 1 week | 1 week |
| 2 | 1 week | 2 weeks |
| 3 | 1 week | 3 weeks |
| 4 | 1 week | 4 weeks |
| 5 | 1 week | 5 weeks |
| 6 | 3 days | ~5.5 weeks |
| 7 | 2 days | ~6 weeks |

**Total Estimated Duration:** ~6 weeks

## Success Criteria

- [ ] All 34 tasks complete
- [x] Test coverage > 80% for new modules (governance: 47/61 tests passing)
- [x] Zero breaking changes to existing functionality
- [x] Documentation complete for all new modules
- [ ] Performance parity or improvement vs v1

## Overall Progress

| Phase | Tasks | Completed |
|-------|-------|-----------|
| 0 | 1 | 1 |
| 1 | 5 | 5 |
| 2 | 4 | 4 |
| 3 | 5 | 5 |
| 4 | 5 | 5 |
| 5 | 5 | 5 |
| 6 | 6 | 6 |
| 7 | 7 | 7 |
| 8 | 4 | 4 |
| 9 | 3 | 3 |
| 10 | 2 | 2 |
| 11 | 2 | 2 |
| 12 | 1 | 1 |
| 13 | 3 | 3 |
| 14 | 5 | 5 |
| 15 | 2 | 2 |
| **Total** | **60** | **55** |

## Phase 14: Security Hardening

**Goal:** Address security vulnerabilities identified in security audit:
1. Rate limiting on Telegram/Discord message handlers (30 msg/min per user)
2. File upload size limits (25MB max)
3. Filename sanitization to prevent path traversal
4. CSRF protection on web UI state-changing endpoints
5. Log injection prevention for user-controlled fields

**Requirements:**
- SEC-01: Rate limiting on message handlers
- SEC-02: File upload size limits
- SEC-03: Filename sanitization
- SEC-04: CSRF protection on web UI
- SEC-05: Log injection prevention

**Plans:**
1/1 plans complete

## Risk Areas

1. **Single global session** → Fixed in Phase 2
2. **No event persistence** → Fixed in Phase 1
3. **No idempotency** → Fixed in Phase 1
4. **Serial queue is process-local** → Fixed in Phase 1
5. **Policy is config-level only** → Fixed in Phase 3
6. **Model router is naive** → Fixed in Phase 4
7. **No test harness** → Fixed in U.1 (Phase 1)
8. **No rate limiting** → Fixed in Phase 14
9. **File upload without size limits** → Fixed in Phase 14
10. **Path traversal in filenames** → Fixed in Phase 14
11. **No CSRF on web UI** → Fixed in Phase 14
12. **Log injection vulnerability** → Fixed in Phase 14
13. **41 test failures** → ✅ Fixed in Phase 15
14. **Code complexity** → ✅ Simplified in Phase 15

## Phase 15: Test Fix & Simplification

**Goal:** 
1. Fix all 41 pre-existing test failures across gateway, governance, escalation, and policy test suites
2. Apply code simplification across entire codebase to improve maintainability

**Requirements:**
- TEST-01: All pre-existing test failures diagnosed and categorized
- TEST-02: Gateway test failures fixed (7+ tests passing)
- TEST-03: Governance test failures fixed (12+ tests passing)
- TEST-04: Escalation/Policy test failures fixed (6+ tests passing)
- TEST-05: All remaining test failures fixed
- TEST-06: Full test suite passes with >95% pass rate
- SIMP-01: Code simplified with clear, explicit patterns
- SIMP-02: Nested ternaries converted to if/else or switch
- SIMP-03: Overly compact code broken into clear steps
- SIMP-04: Redundant abstractions removed
- SIMP-05: Project standards consistently applied
- SIMP-06: All simplifications preserve exact functionality

**Plans:**
2/2 plans complete
- [x] 15-02-PLAN.md — Code simplification (Wave 2, depends on 15-01) ✅ Complete

### Phase 16: Create Agent Command — /claudeclaw:create-agent slash command with wizard flow

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 15
**Plans:** 3/3 plans complete

Plans:
- [x] TBD (run /gsd:plan-phase 16 to break down) (completed 2026-04-08)

### Phase 17: Multi-job agents, wizard workflow field, update-agent command

**Goal:** Make agents first-class, multi-tasking entities. An agent can own multiple independent cron jobs, the wizard captures operational instructions in a dedicated field (not crammed into the schedule), users can update existing agents non-destructively, and the NL→cron parser handles richer time expressions.

**Scope:**
- **Data model:** agents own a `jobs/` subdirectory — `agents/<name>/jobs/<label>.md` each with frontmatter (`cron`, `label`, `enabled`, optional `model`) + trigger-prompt body. Delete agent → delete all jobs.
- **Wizard restructure (`/claudeclaw:create-agent`):**
  - Add dedicated `Workflow` field (multi-line) — becomes SOUL.md / CLAUDE.md system context, separate from cron schedule
  - Scheduled tasks loop: user can add N jobs, each with label + cron + trigger prompt
  - Optional `model` field (default / opus / haiku)
  - Schedule field becomes cron-only, no operational detail
- **NL→cron parser fix:** handle `every day at 7pm`, `every weekday at 9am`, `hourly`, `every Monday`, etc. Broaden preset coverage. **Multi-time per day:** parser must handle arbitrary N-times-daily patterns, not just "twice daily" — e.g. `every day at 7am and 7pm`, `every day at 9am, 1pm, 5pm`, `thrice daily`. Generate cron lists (`0 9,13,17 * * *`).
- **New `/claudeclaw:update-agent` command:** lists agents, loads current config, offers menu (workflow / personality / add job / edit job / remove job / discord / model / delete agent). **Invariant: must never touch MEMORY.md** (preserve accumulated agent state).
- **Runtime:** `jobs.ts` cron loop scans `agents/*/jobs/*.md` in addition to flat jobs dir. Each job fires a fresh session with `agentName=<name>` + that job's trigger prompt. Agent's base SOUL/CLAUDE loads as system context for every job.
- **Deferred to Phase 18 (milestone-blocking):** per-job `model` override wired through the runner. Phase 17 captures `model:` in job frontmatter for forward-compat only; runner does NOT yet honor it. Phase 18 must land before milestone v1.0 can complete and before next production deploy.
- **Discord labelling:** job completion posts include the job label (`Reg: digest-scan complete`) to disambiguate when an agent has multiple jobs.
- **Backwards compat:** Phase 16 single-job agents auto-migrate to `agents/<name>/jobs/default.md` on first load. Standalone non-agent jobs keep working unchanged.

**Related cross-agent context:** Suzy's daily digest output path is moving from `My Drive/Clippings` (Google Drive via gws CLI) to `$VAULT_PATH/POVIEW.AI/Clippings` (Obsidian vault). Reg's `digest-scan` job consumes this path, so Phase 17 docs should reference the vault path. The Suzy-side config change itself is out of scope for this phase — it's a runtime config tweak, not code.

**Requirements**: TBD (derive during /gsd:plan-phase)
**Depends on:** Phase 16
**Plans:** 8/8 plans complete

Plans:
- [x] TBD (run /gsd:plan-phase 17 to break down) (completed 2026-04-08)

### Phase 18: Per-job model override runtime wiring (milestone blocker) ✅

**Goal:** Plumb per-job `model` preference (declared in `agents/<name>/jobs/<label>.md` frontmatter during Phase 17) all the way through the runner so jobs actually execute on the requested model (e.g. Reg's digest-scan runs on sonnet, Reg's draft-writing runs on opus).

**Scope:**
- Extend `runner.ts` to accept a `model` parameter per invocation
- Wire `jobs.ts` cron loop to pass `job.model` (falls back to agent default, then daemon default)
- Wizard + update-agent expose model selection at both agent level (default) and job level (per-task override)
- Validation: reject unknown model strings at load time, not at runtime
- Tests: each supported model string resolves correctly, overrides cascade agent → job, invalid strings error cleanly

**Milestone status:** ✅ **COMPLETE — milestone v1.0 blocker cleared (2026-04-08).** Per-job model override fully wired end-to-end. Reg can now run digest-scan on sonnet and draft-writing on opus; Suzy can run on haiku via agent-level default.

**Requirements**: MODEL-RT-01, MODEL-RT-02, MODEL-RT-03, MODEL-VAL-01, MODEL-VAL-02, MODEL-UI-01, MODEL-UI-02, MODEL-TEST-01 — all complete
**Depends on:** Phase 17
**Plans:** 3/3 plans executed

Plans:
- [x] 18-01 Runtime wiring (RunOptions.modelOverride + loadJobs validation) (completed 2026-04-08)
- [x] 18-02 Agent-level defaultModel middle tier (completed 2026-04-08)
- [x] 18-03 Test coverage expansion + end-to-end integration (completed 2026-04-08)

### Phase 19: Safe fresh-session feature (Discord/Telegram slash + Web UI button)

**Goal:** Give users a one-tap "start a fresh session" action that **never destroys prior session state** — replacing today's `/reset` slash command which calls `unlink(session.json)`. Also fix `backupSession()` so it never overwrites existing backups.

**Why blocking:**
- Current `/reset` (Discord + Telegram) hard-deletes `session.json`, violating the "never delete session.json" rule and losing the conversation history irrecoverably.
- Wizard testing for Phase 17 (and any future skill update) requires a fresh session to load updated skill files from disk, but there's no safe user-facing path. Today the only safe option is shell access + `backupSession()` — not viable for non-dev users.
- `backupSession()` itself has a sharp edge: `nextIndex = max(existing) + 1`, but `rename` will silently overwrite if a target collides (e.g. after manual cleanup). Needs hardening.

**Scope:**
- **Helper:** `safeRotateSession()` — atomic rename to `session_<unix-timestamp>.backup` (or `session_<N>.backup` with collision-safe index), guaranteed never to overwrite. Replace all callers of `backupSession()` and `resetSession()`.
- **Discord:** Replace `/reset` to call `safeRotateSession` instead of `unlink`. Reply with the backup filename so users know the rollback path.
- **Telegram:** Same fix for `/reset` slash command.
- **Web UI:** Add a "Fresh chat" button next to the chat input. POSTs to a new `/api/session/rotate` endpoint that calls `safeRotateSession`. Show a toast with the backup filename.
- **Audit:** Grep all callers of `unlink(session.json)`, `unlink(sessionPath...)`, and `resetSession`. Anywhere outside `deleteAgent()` should be replaced.
- **Tests:** rotation under collision (pre-existing `session_1..N.backup`), concurrent rotate attempts, agent vs global session paths.

**Requirements:** TBD (derive during /gsd:plan-phase)
**Depends on:** none (independent)

Plans:
- [ ] TBD (run /gsd:plan-phase 19 to break down)
