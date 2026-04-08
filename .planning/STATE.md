---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_plan: 18-03
status: in_progress
last_updated: "2026-04-08T17:30:00.000Z"
progress:
  total_phases: 18
  completed_phases: 13
  total_plans: 29
  completed_plans: 33
---

# State: ClaudeClaw v2 Upgrade

## Current Position
**Phase:** 18 — Per-Job Model Override Runtime Wiring (In Progress)
**Current Plan:** 18-03
**Status:** 18-01, 18-02 complete

### 2026-04-08 — Phase 18 Plan 2 (18-02) Completion
- Added agent-level `defaultModel` as middle fallback tier in model resolution cascade
- New `claudeclaw:model:start/end` marker block in `agents/<name>/CLAUDE.md` (Phase 17 managed-block pattern)
- `AgentCreateOpts.defaultModel` + `AgentContext.defaultModel` plumbed through create/load/update
- `renderClaudeMd` emits optional `## Default Model` section when set
- `loadAgent` parses marker block lazily (swallows file-read errors for test compat)
- `updateAgent` supports set/replace/clear (empty string) via new `applyDefaultModelPatch` helper; append mode rejected with explicit error (single-value field)
- `applyDefaultModelPatch` lives OUTSIDE updateAgent function body so UPDATE-02 source-grep test remains meaningful
- Clear path strips both the markers AND the `## Default Model` heading (no orphan empty headings)
- `resolveJobModel` cascade extended: `job.model > loadAgent(job.agent).defaultModel > undefined`
- Dynamic `await import("./agents")` in jobs.ts breaks would-be circular dependency
- Agent load failures in cascade fall through to undefined (one bad agent cannot kill cron)
- create-agent SKILL.md: new "Default model" wizard step, `defaultModel` carried through wizard JSON + scaffold bun -e snippet
- update-agent SKILL.md: new menu option `8. Default model` with set/clear bun -e snippet; Delete/Done renumbered to 9/10
- 16 new agents.test.ts assertions (UPDATE-02 source-grep test + MEMORY.md mtime test included)
- 6 new jobs.test.ts assertions covering full cascade + nonexistent-agent fall-through
- Full suite 730/743 (13 pre-existing failures unchanged from 18-01 baseline)
- Commits: 4a86ca3 (RED), bd2f380 (Task 1 GREEN), f2bd7d4 (Task 2 GREEN)
- Requirements MODEL-RT-03, MODEL-UI-01, MODEL-UI-02 complete

### 2026-04-08 — Phase 18 Plan 1 (18-01) Completion
- Threaded `RunOptions.modelOverride` through `run() → execClaude() → runClaudeOnce()`
- Override branch added before agentic branch in execClaude (override wins, taskType="job-override")
- `runClaudeOnce` exported (one keyword) to enable spy-based unit testing
- New `VALID_MODEL_STRINGS` (opus/sonnet/haiku/glm) + `validateModelString()` + `resolveJobModel()` in jobs.ts
- `loadJobs()` skips invalid-model jobs with `console.error("[ts] Skipping job ...")`, valid siblings still load
- `start.ts` cron tick resolves `job.model → modelOverride` and forwards to `run()`
- `glm` sentinel preserved (runClaudeOnce already handles it via existing model-string check)
- New `src/__tests__/runner.test.ts` (3 tests: override forwarded, settings.model fallback, glm forwarded)
- 14 new jobs.test.ts assertions covering validation + resolveJobModel + loadJobs invalid-model rejection
- Full suite 710/723 (13 pre-existing failures unchanged from baseline)
- Commits: 9ffb0bf (Task 1), 7e6dae9 (Task 2)
- Requirements MODEL-RT-01, MODEL-RT-02, MODEL-VAL-01, MODEL-VAL-02, MODEL-TEST-01 complete

### 2026-04-08 — Phase 17 Plan gap-03 (17-gap-03) Completion
- Closed GAP-17-07: append mode for `updateAgent` workflow/personality/dataSources
- New `PatchField<T> = T | { value, mode: "append"|"replace" }` type — bare strings remain back-compat (replace)
- `applySoulPatch` / `applyClaudeMdPatch` branch on mode; append concatenates inside markers with `\n\n` separator
- New helpers: `normalizePatchField`, `readBetweenMarkers`
- dataSources append on file with no existing block creates a new marked section at end
- update-agent SKILL.md: mode-selection prompt (Append default / Replace / Show current) added before content collection for Options 1, 2, 7; bun -e snippets pass `{ value, mode }` patch shape
- 14 new tests in agents.test.ts (98/98 passing); full suite 697/710 (13 pre-existing failures unchanged)
- MEMORY.md UPDATE-02 invariant preserved under all new append paths (verified by source-grep + mtime tests)
- Commits: 3aa3cd7 (RED), 62eed25 (GREEN), 5bf0bc1 (SKILL.md)
- Requirement UPDATE-03 complete

### 2026-04-08 — Phase 17 Plan gap-02 (17-gap-02) Completion
- Closed GAP-17-05: manual `claudeclaw fire <agent>:<label>` command
- New `src/commands/fire.ts` with `fireJob()`, `runFireCommand()`, `parseFireArgs()`; DI-based for hermetic tests (no real claude exec)
- `src/jobs.ts`: new `loadAgentJobsUnfiltered(agentName)` + `agentDirExists(agentName)` helpers — reuses `parseJobFile` (no parallel parser, respects GAP-17-08)
- CLI: `fire` subcommand wired in `src/index.ts` with exit-code propagation; new `--help` handler listing all subcommands
- Discord: `/fire` text-command intercept in message handler (before skill routing), replies to originating channel with firing/result/error
- Telegram: `/fire` slash command alongside `/reset`, `/status`, `/context`
- Web UI: `POST /api/jobs/fire` with CSRF validation; `/api/jobs` response enriched with `agent`/`label`/`fireable` fields; "Fire now" button per agent-job row in `src/ui/page/script.ts`
- Manual fire bypasses `enabled: false` filter (disabled jobs still fireable on demand)
- 14 new tests in `src/__tests__/fire.test.ts` — all passing; full suite 684/697 (13 pre-existing failures unchanged)
- Commits: 572691b, 3599395, c64020f
- Requirement FIRE-01 complete

### 2026-04-07 — Phase 17 Plan 3 (17-03) Completion
- Added `updateAgent(name, patch)` to `src/agents.ts` with selective field patching for SOUL.md (workflow, personality) and CLAUDE.md (discordChannels, dataSources)
- Pure string transforms: `applySoulPatch` / `applyClaudeMdPatch` — marker-aware with legacy-format regex fallback
- 8 new section marker constants (`claudeclaw:workflow:start/end` etc.) mirroring existing `claudeclaw:managed` convention
- `renderSoul` now wraps Personality in markers and emits optional `## Workflow` section when `opts.workflow` set
- `renderClaudeMd` wraps Discord Channels and Data Sources in markers
- `AgentCreateOpts.workflow?: string` added; threaded through to `renderSoul`
- **UPDATE-02 invariant** enforced: source-grep unit test parses updateAgent function body and asserts zero references to `memoryPath|MEMORY.md|ensureMemoryFile|getMemoryPath|sessionPath|session.json`. mtime tests confirm MEMORY.md untouched after every patch shape.
- 20 new tests; agents.test.ts 85/85 green; full suite 665/678 (13 pre-existing failures unchanged)
- Commits: 3f9a018 (RED), 971204c (GREEN)
- Requirements UPDATE-01, UPDATE-02 complete

### 2026-04-07 — Phase 17 Plan 4 (17-04) Completion
- Extended `loadJobs()` in `src/jobs.ts` to scan both `.claude/claudeclaw/jobs/` AND `agents/*/jobs/*.md`
- Added `label`, `enabled`, `model` fields to `Job` interface; directory location authoritative for `job.agent`
- Disabled jobs (`enabled: false`) filtered at load time
- New `src/migrations.ts` with idempotent `migrateLegacyAgentJobs()` shim — relocates Phase 16 single-job agents to `agents/<name>/jobs/default.md`, strips `agent:` line, prepends `label: default`
- Wired into `src/commands/start.ts`: called once before first `loadJobs()`
- Discord/Telegram cron-loop forwarders now use `${job.agent}: ${job.label}` format for agent jobs
- 10 new tests across 2 files; 95/95 jobs+migrations+agents tests passing
- Commits: d7dec94 (RED jobs), 8e147a8 (GREEN jobs), abad6bb (RED migrations), 543dd27 (GREEN migrations + start.ts wiring)
- Requirements RUNTIME-01, MIGRATE-01, MIGRATE-02, DISCORD-01 complete

### 2026-04-07 — Phase 17 Plan 2 (17-02) Completion
- Broadened `parseScheduleToCron` in `src/agents.ts` to handle 13 additional NL patterns
- `parseHour`: named times (noon, midnight, morning, evening, night) + stricter am/pm range (1..12)
- New presets: `twice daily` (9,21), `thrice daily` (9,13,17), `every weekend` (0,6)
- `every N hours` parser (1..23) with `0 */N * * *` output
- Multi-time-per-day parser: "at 7am and 7pm" / "at 9am, 1pm, 5pm" → comma-separated cron hours
- Bug fix: tightened RAW_CRON_RE to cron-valid chars only (was false-matching "every day at 7 pm")
- safeCron helper validates output via cronMatches before returning
- 20 new tests, 65/65 in agents.test.ts; full suite 635/648 (13 pre-existing failures unchanged)
- Commits: 2957a54 (RED), 20a7253 (GREEN)
- Requirement CRON-01 complete

### 2026-04-07 — Phase 17 Plan 1 (17-01) Completion
- Added multi-job CRUD primitives to `src/agents.ts`: validateJobLabel, agentJobsDir, addJob, updateJob, removeJob, listAgentJobs, deleteAgent
- New `AgentJob` interface (label, cron, enabled, model?, trigger, path)
- Refactored `createAgent` to write scheduled task to `agents/<name>/jobs/default.md` instead of legacy `.claude/claudeclaw/jobs/<name>.md`
- Strengthened cron validation with structural pre-check (5 fields + char whitelist)
- 19 new Phase 17 tests + 2 updated Phase 16 tests; full agents.ts suite 45/45 passing
- Full suite 615/628 (13 pre-existing failures unchanged); tsc baseline unchanged
- Commit: 3332ddf

### 2026-04-06 — Phase 16 Plan 2 (16-02) Completion
- Threaded optional `agentName` through sessions, runner, jobs, send command, cron loop
- `src/sessions.ts`: agent sessions at `agents/<name>/session.json`, bypass module cache
- `src/runner.ts`: new `loadAgentPrompts` helper; agent prompts replace global ones when set
- `src/jobs.ts`: `Job.agent` optional field, parsed from frontmatter
- `src/commands/send.ts`: `--agent <name>` flag routes to agent's session
- `src/commands/start.ts`: cron loop passes `job.agent` to `run()`
- 6 new sessions tests; full suite 596/609 (13 pre-existing failures unchanged); tsc baseline unchanged

### 2026-04-06 — Phase 16 Plan 1 (16-01) Completion
- Created `src/agents.ts` with validateAgentName, parseScheduleToCron, createAgent, loadAgent, listAgents
- 26 unit/integration tests in `src/__tests__/agents.test.ts`, all passing
- NL→cron parser handles 9 documented presets + raw cron passthrough
- Lazy cwd resolution pattern for test/runtime alignment
- No regressions: 13 pre-existing failures unchanged

## Phase Overview

| Phase | Name | Status | Plans |
|-------|------|--------|-------|
| 0 | Project Initialization | ✅ Complete | 0 |
| 1 | Event Bus | ✅ Complete | 5 |
| 2 | Session Gateway | ✅ Complete | 4/4 |
| 3 | Policy Engine | ✅ Complete | 1/1 |
| 4 | Cost Governance | ✅ Complete | 2/2 |
| 5 | Orchestration | ✅ Complete | 1/1 |
| 6 | Human Escalation | ✅ Complete | 2/2 |
| 7 | Additional Adapters | ✅ Complete | 1/1 |
| 8 | Policy Integration | ✅ Complete | 1/1 |
| 9 | Gateway Integration | ✅ Complete | 1/1 |
| 10 | Orchestrator Governance Bridge | ✅ Complete | 1/1 |
| 11 | Policy Engine Verification | ✅ Complete | 2/2 |
| 12 | Verify Adapter Docs | ✅ Complete | 1/1 |
| 13 | Gap Closure | ✅ Complete | 1/1 |
| 14 | Security Hardening | ✅ Complete | 1/1 |
| 15 | Test Fix & Simplification | ◐ Partial | 2/2 |

## Decisions Log

### 2026-03-26 — Project Initialization
1. **Adopt GSD workflow** — Use structured planning and execution
2. **Sequential phases** — Each phase gates the next (dependencies)
3. **Additive changes only** — No rewrites of existing modules
4. **TDD required** — All new modules need >80% test coverage
5. **Flat file persistence** — No database dependencies
6. **Bun runtime** — Continue with existing Bun-based stack

### 2026-03-27 — Phase 1 Retroactive Documentation
- Phase 1 modules (event-log, event-processor, retry-queue, dead-letter-queue, replay) confirmed complete
- Created retroactive SUMMARY.md for Phase 1
- All Phase 1 success criteria met

### 2026-03-27 — Phase 2 Plan 1 (2-01) Completion
- Session Map Store implemented with hierarchical per-channel+thread isolation
- Write queue serialization pattern following event-log.ts conventions
- 30 comprehensive unit tests passing
- File: `.claude/claudeclaw/session-map.json`

### 2026-03-27 — Phase 2 Plan 2 (2-02) Completion
- NormalizedEvent schema implemented with Channel, Attachment types and type guards
- seq field excluded from NormalizedEvent (belongs to event log, not normalizer)
- Telegram channelId format: `telegram:<chat.id>`
- Discord channelId preserves guild context: `discord:guild:<guild_id>:<channel_id>`
- System actor userId = "system" for Cron/Webhook events
- Sensitive webhook headers (authorization, cookie, x-api-key, x-auth) stripped from metadata
- 44 tests covering all normalizers and edge cases

### 2026-03-27 — Phase 2 Plan 3 (2-03) Completion
- Resume logic module created at src/gateway/resume.ts
- getResumeArgs returns --resume only when real Claude session ID exists
- Post-processing updates lastSeq, turnCount, lastActiveAt, updatedAt
- Lifecycle helpers: resetSession, isSessionStale, shouldWarnCompact
- 34 comprehensive unit tests passing
- Test isolation ensured via file cleanup between tests

### 2026-03-27 — Phase 2 Plan 4 (2-04) Completion
- Gateway orchestrator created at src/gateway/index.ts
- Gateway class with processInboundEvent() following canonical flow
- Event log as source of truth for sequence numbers (not getLastSeq+1)
- Feature flag (isGatewayEnabled) with USE_GATEWAY env var support
- processEventWithFallback() for gradual migration from legacy handlers
- Adapter helpers: submitTelegramToGateway, submitDiscordToGateway
- 19 comprehensive integration tests passing
- Phase 2 Session Gateway now complete (4/4 plans)

### 2026-03-27 — Phase 3 Plan 1 (3-01) Completion
- Policy engine core at src/policy/engine.ts with deterministic rule evaluation
- Scoped channel/user policies at src/policy/channel-policies.ts
- Skill policy overlays at src/policy/skill-overlays.ts
- Approval workflow at src/policy/approval-queue.ts (durable JSONL queue)
- Audit log at src/policy/audit-log.ts (comprehensive audit trail)
- 87 tests covering all policy components
- Files: .claude/claudeclaw/policies.json, approval-queue.jsonl, audit-log.jsonl

### 2026-03-27 — Phase 4 Plan 1 (4-01) Completion
- Governance modules at src/governance/ with 5 components:
  - Usage Tracker: Durable per-invocation usage records in .claude/claudeclaw/usage/
  - Budget Engine: Policy-driven budget evaluation (warn/degrade/reroute/block)
  - Model Router: Governance-aware routing integrating with existing classifier
  - Watchdog: Runaway detection with configurable limits
  - Telemetry: Comprehensive governance metrics API
- 47/61 tests passing (test isolation issues due to shared storage, not bugs)
- Phase 4 is prerequisite for Phase 5 Orchestration

### 2026-03-28 — Phase 4 Plan 2 (4-02) Completion
- Wired runner.ts to governance modules:
  - Imported governance/model-router selectModel for budget-aware routing
  - Imported usage-tracker for invocation recording (start/completion/failure)
  - Imported watchdog for execution monitoring
  - Added ensureGovernanceRouter initialization with agentic modes
  - Added invocation tracking (invocationId, sessionId) in execClaude
  - Wrapped Claude execution in try/catch for failure recording
  - Added watchdog limit checks after execution and compact retry
- Phase 4 now fully integrated with execution path

### 2026-03-28 — Phase 5 Plan 1 (5-01) Completion
- Orchestration layer implemented with 5 modules:
  - task-graph.ts: Graph validation, cycle detection, topological sorting, ready-task identification
  - workflow-state.ts: Atomic crash-safe state persistence to .claude/claudeclaw/workflows/
  - executor.ts: Task execution with Phase 3/4 governance integration
  - resumable-jobs.ts: Job scheduling, cron triggers, daemon restart recovery
  - telemetry.ts: Audit records and metrics derived from persisted state
- 83 unit tests covering all orchestration components
- Key patterns: continuedTasks tracking, deterministic restart reclassification, handler registry

### 2026-03-28 — Phase 6 Plan 1 (6-01) Completion
- Human Escalation layer implemented with 5 modules:
  - pause.ts: Durable pause/resume with admission_only and admission_and_scheduling modes
  - handoff.ts: Structured handoff packages with workflow/session/event context
  - notifications.ts: 7 notification types with rate limiting and deduplication
  - triggers.ts: Policy-driven escalation for watchdog, DLQ, policy, orchestration failures
  - status.ts: Read-side status view for operator dashboards
- 129 unit tests covering all escalation components
- Key patterns: Durable state persistence, audit logging, policy-driven triggers

### 2026-03-28 — Phase 6 Plan 2 (6-02) Gap Closure
- Wired escalation functions into gateway and orchestrator:
  - shouldBlockAdmission() wired to Gateway.processInboundEvent()
  - shouldBlockScheduling() wired to Orchestrator.executeReadyTasks()
  - handleWatchdogTrigger() wired to Runner on watchdog kill/suspend
  - handleOrchestrationFailure() wired to Executor on workflow failure
- Created 15 integration tests for escalation wiring
- 354 tests passing (129 escalation + 83 orchestrator + 127 gateway + 15 new integration)

### 2026-03-28 — Phase 7 Plan 1 (7-01) Completion
- Adapter architecture package created at src/adapters/:
  - README.md: Architecture overview, control-plane boundaries, lifecycle
  - contracts.md: ChannelAdapter interface, AdapterCapabilities, capability matrix
  - configuration.md: Environment patterns, secrets handling, webhook vs socket tradeoffs
- Per-adapter scaffolds created for future implementation:
  - slack/README.md: Events API vs Socket Mode, thread_ts threading, OAuth scopes
  - teams/README.md: Azure Bot Framework, Adaptive Cards, JWT validation
  - email/README.md: IMAP/SMTP, header-based threading, SPF/DKIM security
  - github/README.md: GitHub Apps, webhook validation, JWT + installation tokens
- All scaffolds explicitly state "no working implementation included"
- 3,161 lines of documentation created
- 7 per-task commits with no fake code

### 2026-03-30 — Phase 8 Plan 1 (8-01) Gap Closure
- GovernanceClient interface created at src/governance/client.ts
  - Unified access to policy evaluation, approval queue, and governance telemetry
  - Singleton pattern with getGovernanceClient() and initGovernanceClient()
- Policy engine evaluate() wired to gateway via evaluatePolicy() and checkToolApproval()
  - Policy evaluation happens after session mapping (Step 2b)
  - Denied requests return error immediately
  - require_approval requests enqueue to durable approval queue
- Runner prepared with evaluateToolForExecution() wrapper for future per-tool hooks
- 4 tasks completed: GovernanceClient, gateway wiring, runner wrapper, integration tests
- REQ-3.1, REQ-3.3, REQ-5.1 requirements completed

### 2026-03-30 — Phase 9 Plan 1 (9-01) Gateway Integration
- Wired Telegram and Discord adapters to gateway layer
- Per-adapter feature flags: USE_GATEWAY_TELEGRAM and USE_GATEWAY_DISCORD
- Fail-closed behavior: when flag is false, return clear error message (no legacy fallback)
- 12 integration tests covering routing, error handling, and flag isolation

### 2026-03-30 — Phase 10 Plan 1 (10-01) Orchestrator Governance Bridge
- OrchestratorGovernanceAdapter created at src/orchestrator/governance-adapter.ts
- Adapter implements executor's GovernanceClient interface (checkPolicy, checkBudget)
- checkPolicy delegates to realClient.evaluateToolRequest with proper ToolRequestContext
- checkBudget delegates to evaluateBudget with sessionId scope
- 11 unit tests covering all adapter behaviors
- Requirements completed: orchestrator-governance-interface, governance-client-orchestrator-mismatch, orchestrator-governance-flow

### 2026-03-30 — Phase 11 Plan 1 (11-01) Gap Closure: Re-verify Policy Engine
- Re-verified Phase 3 Policy Engine artifacts as present and functional
- Confirmed 10/10 artifacts: 5 modules (1,886 lines) + 5 test files
- Modules verified: engine.ts (526), channel-policies.ts (344), skill-overlays.ts (275), approval-queue.ts (335), audit-log.ts (406)
- All 8 truths confirmed ACHIEVED
- Stale 03-VERIFICATION.md (claimed 0/10 artifacts) corrected
- 94/95 tests pass; 1 failure is pre-existing test isolation issue in audit-log.test.ts

### 2026-03-30 — Phase 11 Plan 2 (11-02) Gap Closure: Audit Logging
- Added audit logging to GovernanceClient.evaluateToolRequest()
- Every policy decision now logged via logPolicyDecision() after evaluate() returns
- Fire-and-forget logging with .catch() - audit failures do NOT block policy decisions
- Both gateway and runner paths automatically log because they both call gc.evaluateToolRequest()
- Truth restored: "Every decision is written to an audit log" - ACHIEVED

### 2026-03-30 — Phase 12 Plan 1 (12-01) Adapter Documentation Verification
- Verified Phase 7 adapter documentation is complete (3,161 lines across 7 files)
- All files exist with expected line counts: README.md (268), contracts.md (327), configuration.md (467), slack/README.md (438), teams/README.md (461), email/README.md (581), github/README.md (619)
- Key sections verified present in each file per requirements
- Cross-document consistency confirmed (ChannelAdapter in contracts.md, referenced by all adapter READMEs)
- All per-adapter scaffolds explicitly disclaim implementation ("no working implementation")
- Created 12-VERIFICATION.md with full verification report

### 2026-03-30 — Phase 13 Plan 1 (13-01) Gap Closure
- Wired OrchestratorGovernanceAdapter via setGovernanceClient() in initializeJobSystem()
- Policy denials trigger escalation via handlePolicyDenial() in gateway
- DLQ overflow triggers escalation via handleDlqOverflow() when threshold (100) exceeded
- All 3 remaining integration gaps from v1.0 milestone audit now closed

### 2026-03-30 — Phase 14 Plan 1 (14-01) Security Hardening
- Rate limiting: 30 msg/min per user on Telegram and Discord (in-memory Map)
- File size limits: 25MB cap on all attachment downloads
- Filename sanitization: Removes null bytes, path traversal sequences, unsafe characters
- CSRF protection: Token validation on all web UI POST endpoints (/api/settings/heartbeat, /api/jobs/quick, /api/chat)
- Log injection prevention: sanitizeForLog applied to all user-controlled fields in event-log.ts
- Requirements SEC-01 through SEC-05 completed

### 2026-03-31 — Phase 15 Plan 1 (15-01) Test Fix & Simplification
- Fixed 9 test files and rebuilt retry-queue event handling
- Root cause: Test isolation issues - tests reading real data from .claude/claudeclaw/
- Solution: Clean actual data directories before each test in beforeEach
- Fixed retry-queue rebuildFromEventLog bug (handle __status_update__ events properly)
- Test pass rate: 574/577 (99.5%) - exceeds >95% target
- Remaining 3 failures are pre-existing test isolation issues

### 2026-03-31 — Phase 15 Plan 2 (15-02) Code Simplification
- Converted nested ternary operators to if/else chains in 4 files:
  - telegram.ts: handleCallbackQuery() answer text selection
  - status.ts: formatStatus() icon emoji selection
  - normalizer.ts: normalizeTelegramMessage() and normalizeDiscordMessage() attachment types
- Simplified chained .replace() calls in extractReactionDirective() (telegram.ts and discord.ts)
- Preserved intentional HTML escaping pipelines (3 chained replaces) as deliberate patterns
- Test pass rate maintained: 574 pass / 3 fail (pre-existing)

### Roadmap Evolution
- Phase 16 added: Create Agent Command — /claudeclaw:create-agent slash command with wizard flow (refs #78)
- Phase 17 added: Multi-job agents, wizard workflow field, update-agent command — data model change (agents own multiple cron jobs under agents/<name>/jobs/), wizard adds dedicated Workflow field (separates operational instructions from cron schedule), NL→cron parser fix (`every day at 7pm`, plus N-times-daily patterns like `every day at 9am, 1pm, 5pm`), /claudeclaw:update-agent command (preserves MEMORY.md), backwards-compat migration for Phase 16 single-job agents. Related cross-agent context: Suzy's daily digest output path migrating from `My Drive/Clippings` (gws CLI) to `$VAULT_PATH/POVIEW.AI/Clippings` (Obsidian vault) — Reg's digest-scan job will read from the new vault path. Decisions from research review (2026-04-07): per-job model override deferred to Phase 18 (frontmatter captured in P17 for forward-compat, runner wiring in P18); `twice daily` preset broadened to general N-times-daily parsing; update-agent vs in-flight cron race documented as benign; delete-agent cleanup verified via test; Suzy path change already in place user-side.
- Phase 18 added: Per-job model override runtime wiring — MILESTONE BLOCKER 🚧. Plumbs `model` field from job frontmatter through runner.ts so jobs execute on requested model (e.g. Reg digest-scan on sonnet, Reg draft-writing on opus). Blocks milestone v1.0 completion and next production deploy.

## Blockers
None

## Next Actions
1. ✅ All 14 phases complete — ClaudeClaw v2 architecture fully verified
2. ✅ Phase 15 Plan 1 (15-01) Complete - 99.5% test pass rate
3. ✅ Phase 15 Plan 2 (15-02) Complete - Code simplification complete
4. Future: Implement Slack adapter (requires Phase 7 documentation as guide)
5. Future: Implement GitHub adapter (requires Phase 7 documentation as guide)
6. Future: Implement Email adapter (requires Phase 7 documentation as guide)
7. Future: Implement Teams adapter (requires Phase 7 documentation as guide)
