---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
verified: 2026-04-08T00:00:00Z
status: human_needed
score: 5/5 gaps closed in code; full phase goal verified by artifact + wiring grep + 112/112 unit tests
re_verification:
  previous_status: gaps_found
  previous_score: "3/8 gate items (GAP-17-01, -06, -08 closed; -02, -03, -04, -05, -07 open)"
  gaps_closed:
    - "GAP-17-02 workflow/trigger redundancy — single-job reuse branch present in create-agent SKILL.md"
    - "GAP-17-03 dropped-ack recovery — Echo before asking + per-answer /tmp/claudeclaw-agent-wizard.json persistence + Review before scaffolding block all present"
    - "GAP-17-04 local-vs-remote cron confusion — 'IMPORTANT — Jobs are LOCAL cron' callout present in both create-agent and update-agent SKILL.md"
    - "GAP-17-05 manual fire command — src/commands/fire.ts exports fireJob/runFireCommand/parseFireArgs, wired into index.ts (CLI), commands/discord.ts, commands/telegram.ts, ui/server.ts (POST /api/jobs/fire), ui/page/script.ts (Fire-now button); 14 unit tests passing"
    - "GAP-17-07 updateAgent append mode — PatchField<T> type, normalizePatchField, readBetweenMarkers helpers added; append branch in applySoulPatch/applyClaudeMdPatch; update-agent SKILL.md asks 'How should this be applied' with Append default; 14 new agents tests passing"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Fresh create-agent wizard end-to-end on Hetzner (cwd /home/claw/project, source /opt/claudeclaw) after deploy"
    expected: "Single-job agent with non-empty workflow skips Q7c trigger prompt; wizard echoes prior answers; state file appears in /tmp/claudeclaw-agent-wizard.json after each answer; final review block appears before scaffold; scheduled tasks section shows local-cron callout"
    why_human: "Wizards are prompt-driven markdown instructions executed by Claude interactively — only a live run confirms the UX actually behaves as written"
  - test: "claudeclaw fire reg:daily-content-research on a deployed agent"
    expected: "Job runs once, streams to stdout, exits 0; disabled jobs still fireable; missing agent/label returns non-zero with clear error"
    why_human: "Unit tests cover logic with injected runner; real claude CLI invocation and Discord/Telegram/Web-UI surfaces need live confirmation"
  - test: "update-agent wizard Option 1 (Workflow) append flow"
    expected: "User chooses Append, adds 3 sentences; existing 300-word workflow is preserved with new content concatenated after a blank line inside claudeclaw:workflow markers"
    why_human: "Wizard behavior is Claude-interpreted markdown; append correctness in updateAgent is unit-tested but the wizard's mode-selection prompt UX needs a real run"
---

# Phase 17: Multi-Job Agents, Wizard Workflow Field, Update-Agent Command — Verification Report

**Phase Goal:** Make agents first-class, multi-tasking entities. An agent can own multiple independent cron jobs, the wizard captures operational instructions in a dedicated field (not crammed into the schedule), users can update existing agents non-destructively, and the NL→cron parser handles richer time expressions.

**Verified:** 2026-04-08
**Status:** human_needed (all automated checks pass; wizard UX + live deploy need human UAT)
**Re-verification:** Yes — gap-closure pass after 5 previously-open UAT gaps.

## Goal Achievement

### Observable Truths (Phase-level + Gap-closure)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Agents can own multiple independent cron jobs via `addJob`/`updateJob`/`removeJob`/`listAgentJobs` | VERIFIED | `src/agents.ts` exports all four; `src/jobs.ts` scans `agents/*/jobs/*.md` |
| 2 | Job files use `schedule:` key matching native scheduler (GAP-17-08 fix) | VERIFIED | `grep schedule: src/agents.ts` → 3 hits in renderJobFile/updateJob/parseJobFileContent |
| 3 | Wizard captures workflow in dedicated field, not schedule | VERIFIED | create-agent SKILL.md Q4 Workflow + SOUL.md `claudeclaw:workflow` markers |
| 4 | `updateAgent` supports non-destructive edits | VERIFIED | `PatchField<T>`, `normalizePatchField`, append branch in agents.ts; 98/98 agents tests pass |
| 5 | NL→cron parser handles richer expressions | VERIFIED | `parseScheduleToCron` present in src/agents.ts with tests in agents.test.ts |
| 6 | GAP-17-02 single-job workflow reuse (skip redundant trigger) | VERIFIED | `Run the workflow defined in SOUL.md` present in create-agent SKILL.md |
| 7 | GAP-17-03 wizard echo + per-answer persistence + review block | VERIFIED | `Echo before asking`, `claudeclaw-agent-wizard.json`, `Review before scaffolding` all present (8 hits) |
| 8 | GAP-17-04 local-cron callout in both wizards | VERIFIED | `IMPORTANT — Jobs are LOCAL cron` present in create-agent (matches) and update-agent SKILL.md (matches) |
| 9 | GAP-17-05 manual `fire` command across CLI + Discord + Telegram + Web UI | VERIFIED | `src/commands/fire.ts` exports fireJob/runFireCommand/parseFireArgs; referenced by index.ts, commands/discord.ts, commands/telegram.ts, ui/server.ts, ui/page/script.ts; 14 unit tests in fire.test.ts |
| 10 | GAP-17-07 update-agent append mode (non-destructive default) | VERIFIED | `PatchField`, `append`, `readBetweenMarkers`, `normalizePatchField` (19 hits in agents.ts); `How should this be applied` in update-agent SKILL.md; 14 new tests |

**Score:** 10/10 truths verified by automated checks; 3 items flagged for live human UAT (see frontmatter).

### Required Artifacts

| Artifact | Status | Details |
|---|---|---|
| `skills/create-agent/SKILL.md` | VERIFIED | Contains all 5 wizard UX markers |
| `skills/update-agent/SKILL.md` | VERIFIED | Contains local-cron callout + mode-selection prompt |
| `src/commands/fire.ts` | VERIFIED | Exports present, imported by 5 downstream modules |
| `src/__tests__/fire.test.ts` | VERIFIED | 14 tests passing |
| `src/agents.ts` (append mode) | VERIFIED | PatchField + append logic present, 98/98 agents tests pass |
| `src/__tests__/agents.test.ts` | VERIFIED | 98 tests passing (84 prior + 14 new) |

### Key Link Verification

| From | To | Status |
|---|---|---|
| create-agent wizard single-job branch | "Run the workflow defined in SOUL.md" | WIRED |
| every wizard question | /tmp/claudeclaw-agent-wizard.json | WIRED |
| src/commands/fire.ts | src/runner.ts `run()` via dependency injection | WIRED |
| src/commands/fire.ts | src/jobs.ts `loadAgentJobsUnfiltered` | WIRED (no parallel parser, per GAP-17-08 lesson) |
| src/index.ts | src/commands/fire.ts (CLI subcommand) | WIRED |
| src/commands/discord.ts | fireJob | WIRED |
| src/commands/telegram.ts | fireJob | WIRED |
| src/ui/server.ts | POST /api/jobs/fire → fireJob | WIRED (CSRF-gated) |
| src/ui/page/script.ts | Fire-now button → /api/jobs/fire | WIRED |
| AgentUpdatePatch | applySoulPatch/applyClaudeMdPatch append branch | WIRED |
| update-agent wizard Options 1/2/7 | { value, mode } patch shape | WIRED |

### Test Results

- `bun test src/__tests__/fire.test.ts src/__tests__/agents.test.ts` → **112/112 passing**, 277 expect() calls, 193ms.
- Gap-03 summary reports full suite 697/710 (13 pre-existing failures unchanged from STATE.md baseline).

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| WIZARD-01, WIZARD-02 | gap-01 | SATISFIED | create-agent + update-agent SKILL.md edits verified by grep |
| FIRE-01 | gap-02 | SATISFIED | fire.ts + 5 wiring sites + 14 tests |
| UPDATE-03 | gap-03 | SATISFIED | append mode + PatchField + 14 new tests |

Full requirements mapping for core plans 17-01..17-05 was previously accepted (gate items GAP-17-01, -06, -08 marked closed in 17-GAPS.md).

### Anti-Patterns Found

None. Gap-02 explicitly reused `parseJobFile` via new `loadAgentJobsUnfiltered` helper rather than duplicating, respecting the GAP-17-08 no-parallel-parsers lesson.

### Gaps Summary

All 5 previously-open UAT gaps (GAP-17-02, -03, -04, -05, -07) are closed in code, covered by tests, and wired into downstream surfaces. The remaining verification work is **live UAT on the Hetzner server** after deploy — the wizards are prompt-driven markdown executed interactively by Claude, and the fire command's real `claude` CLI invocation plus Discord/Telegram/Web-UI surfaces need human confirmation. These are listed in the `human_verification` frontmatter block.

Phase 17 gate (from 17-GAPS.md) is now fully green pending that human UAT pass.

---

_Verified: 2026-04-08_
_Verifier: Claude (gsd-verifier)_
