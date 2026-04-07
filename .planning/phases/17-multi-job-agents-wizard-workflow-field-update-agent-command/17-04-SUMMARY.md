---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: 04
subsystem: runtime
tags: [jobs, runtime, migration, discord, telegram]
requires: [17-01]
provides: [multi-source-loadJobs, migrateLegacyAgentJobs, agent-label-forwarders]
affects: [src/jobs.ts, src/commands/start.ts]
tech_stack:
  added: []
  patterns: [idempotent-migration-shim, directory-as-source-of-truth]
key_files:
  created:
    - src/migrations.ts
    - src/__tests__/jobs.test.ts
    - src/__tests__/migrations.test.ts
  modified:
    - src/jobs.ts
    - src/commands/start.ts
decisions:
  - "Directory location is authoritative for job.agent — any frontmatter agent: field inside agents/<name>/jobs/*.md is ignored"
  - "Disabled jobs filtered at loadJobs() time to keep cron loop unchanged"
  - "Migration shim lives in dedicated src/migrations.ts (not src/agents.ts) to keep file ownership disjoint from parallel plan 17-03"
metrics:
  duration_minutes: ~15
  tasks_completed: 2
  tests_added: 10
  tests_passing: 95
  completed: 2026-04-07
---

# Phase 17 Plan 4: Multi-Job Runtime Wiring Summary

Wires Phase 17's multi-job data model into the daemon: `loadJobs()` now scans both the legacy flat dir and `agents/*/jobs/*.md`, a one-shot idempotent migration shim relocates Phase 16 single-job agents on startup, and Discord/Telegram completion forwarders include the job label.

## What Was Built

### Task 1 — `loadJobs()` extension
- Added `label`, `enabled`, `model` fields to the `Job` interface (`src/jobs.ts`).
- `parseJobFile` parses the three new frontmatter fields. `label` defaults to the job name, `enabled` defaults to true, `model` is optional.
- `loadJobs()` keeps the existing flat-dir scan unchanged, then walks `agents/*/jobs/*.md`. For each agent job file:
  - `job.name` = `${agentName}/${labelFromFile}` (uniqueness)
  - `job.agent` = directory name (overrides any frontmatter)
  - `job.label` = file basename
- Disabled jobs (`enabled: false`) are filtered out at load time.
- Missing `agents/` dir or missing per-agent `jobs/` dir is silently tolerated.
- 6 tests in `src/__tests__/jobs.test.ts`.

### Task 2 — Migration shim + start.ts wiring + forwarder labels
- New `src/migrations.ts` exporting `migrateLegacyAgentJobs(): Promise<{ migrated; skipped }>`.
- For every `.claude/claudeclaw/jobs/*.md` with an `agent:` frontmatter field AND existing `agents/<name>/` dir, the shim:
  1. Creates `agents/<name>/jobs/`
  2. Writes the file as `default.md`, stripping `agent:` and prepending `label: default`
  3. Deletes the original
- Skips when no `agent:` field, target file already exists, or agent dir absent — making it idempotent.
- `src/commands/start.ts` calls it exactly once, immediately before the first `loadJobs()`. Logs the count when migrations occur.
- Cron-loop Discord/Telegram forwarders now compute `forwardLabel = job.agent && job.label ? \`${job.agent}: ${job.label}\` : job.name` and pass that to `forwardToTelegram` / `forwardToDiscord`. Function signatures unchanged.
- 4 tests in `src/__tests__/migrations.test.ts`.

## Verification

```
bun test src/__tests__/jobs.test.ts src/__tests__/migrations.test.ts src/__tests__/agents.test.ts
# 95 pass, 0 fail, 231 expect() calls

grep -n "migrateLegacyAgentJobs" src/commands/start.ts
# 9: import, 318: call (before loadJobs at line 326)

grep -n "forwardLabel" src/commands/start.ts
# 729-731: cron loop uses agent:label format
```

`bun build src/commands/start.ts --target=bun` succeeds (no compile errors).

### Manual end-to-end check (deferred to live daemon)

```
bun run src/index.ts start
# In another shell, create an agent + job:
#   /claudeclaw:create-agent tst-x ...
# Confirm "[runner] firing job tst-x/default" appears in the log within 60s of cron match.
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Job interface field name mismatch**
- **Found during:** Task 1
- **Issue:** Plan's `<interfaces>` block listed `cron`, `prompt`, `notify?` for the existing `Job` interface, but the actual interface in `src/jobs.ts` uses `schedule`, `recurring`, `notify` (required, not optional). Following the plan literally would have broken every existing call site.
- **Fix:** Preserved existing field names; added `label`, `enabled`, `model` as additive optional fields.
- **Files modified:** `src/jobs.ts`
- **Commit:** 8e147a8

**2. [Rule 3 - Blocking] CLI entry point path**
- **Issue:** Plan's verification step references `bun run src/cli.ts --help`, but the entry is `src/index.ts`. Substituted `bun build src/commands/start.ts --target=bun` for compile verification (cleaner: catches type errors without daemon side-effects).

No other deviations. Auth gates: none.

## Requirements Closed
- RUNTIME-01: cron loop discovers jobs from both flat dir AND `agents/*/jobs/`
- MIGRATE-01: Phase 16 single-job agents auto-migrate on first daemon start, idempotently
- MIGRATE-02: standalone non-agent jobs in flat dir continue to work unchanged
- DISCORD-01: completion forwarders include the job label

## Self-Check: PASSED
- src/jobs.ts modified ✓
- src/migrations.ts created ✓
- src/commands/start.ts modified ✓
- src/__tests__/jobs.test.ts created ✓
- src/__tests__/migrations.test.ts created ✓
- Commits d7dec94, 8e147a8, abad6bb, 543dd27 all present in git log ✓
