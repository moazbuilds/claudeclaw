---
phase: 18-per-job-model-override-runtime-wiring-milestone-blocker
plan: 02
subsystem: agents+jobs
tags: [agents, jobs, model-override, default-model, milestone-blocker]
requires:
  - src/agents.ts createAgent/loadAgent/updateAgent
  - src/jobs.ts resolveJobModel (from Plan 01)
  - CLAUDE.md marker-block pattern from Phase 17
provides:
  - AgentCreateOpts.defaultModel + AgentContext.defaultModel
  - claudeclaw:model:start/end marker block in agents/<name>/CLAUDE.md
  - updateAgent support for set/replace/clear defaultModel (append mode rejected)
  - resolveJobModel cascade: job.model > agent.defaultModel > undefined
  - create-agent wizard step for default model
  - update-agent menu option for default model
affects:
  - src/agents.ts
  - src/jobs.ts
  - src/__tests__/agents.test.ts
  - src/__tests__/jobs.test.ts
  - skills/create-agent/SKILL.md
  - skills/update-agent/SKILL.md
tech-stack:
  added: []
  patterns:
    - marker-wrapped-managed-block
    - lazy-import-to-break-circular-dependency
    - single-value-patchfield-with-clear-via-empty-string
key-files:
  created: []
  modified:
    - src/agents.ts
    - src/jobs.ts
    - src/__tests__/agents.test.ts
    - src/__tests__/jobs.test.ts
    - skills/create-agent/SKILL.md
    - skills/update-agent/SKILL.md
decisions:
  - defaultModel lives in CLAUDE.md as marker block (not SOUL.md) — it's config, not identity
  - Clear via empty string also strips the `## Default Model` heading (clean round-trip)
  - resolveJobModel uses dynamic `await import("./agents")` to prevent circular import at module load
  - applyDefaultModelPatch lives OUTSIDE updateAgent function body so the UPDATE-02 source-grep test remains meaningful
  - Append mode rejected at runtime with explicit error (single-value field)
  - Agent load failures in resolveJobModel fall through to undefined — one bad agent must not break cron
metrics:
  duration: ~20min
  completed: 2026-04-08
requirements: [MODEL-RT-03, MODEL-UI-01, MODEL-UI-02]
---

# Phase 18 Plan 02: Agent-Level Default Model Summary

Added the middle tier of the model-resolution cascade: an agent can declare a `defaultModel` in its CLAUDE.md managed block, and `resolveJobModel()` now falls back to it when a job has no explicit `model:` field. Wizards and update flows updated to expose the new knob.

## Tasks Completed

| Task | Name                                                     | Commit  |
| ---- | -------------------------------------------------------- | ------- |
| RED  | Failing tests for agent defaultModel                     | 4a86ca3 |
| 1    | agents.ts defaultModel field + marker block + updateAgent | bd2f380 |
| 2    | resolveJobModel cascade + skills integration             | f2bd7d4 |

## Implementation Notes

**agents.ts** — New `CLAUDE_MD_MODEL_START`/`END` markers, `AgentCreateOpts.defaultModel` field, and `AgentContext.defaultModel` on the loaded context. `renderClaudeMd()` emits an optional `## Default Model` section wrapped in markers when the field is set. `loadAgent()` reads the marker block lazily (swallowing file-read errors to stay compatible with agents created by bare filesystem operations in tests).

`applyDefaultModelPatch()` is a top-level helper (deliberately outside the `updateAgent` function body so the UPDATE-02 source-grep test stays meaningful). It handles three cases: set-fresh (append new marked section at EOF), replace (use `replaceBetweenMarkers`), and clear via empty string (strip the block *and* the preceding `## Default Model` heading). Append mode throws a clear error — single-value fields cannot be concatenated.

Validation: `validateModelString` is imported from jobs.ts. Called both at `createAgent` time and at `updateAgent` time before writing. Normalized to lowercase + trimmed at write.

**jobs.ts** — `resolveJobModel` now has three branches:
1. `job.model` set → return it lowercased+trimmed
2. `job.agent` set → `await import("./agents")`, call `loadAgent`, return `ctx.defaultModel` if present
3. fall through → undefined

The dynamic import is the standard Node/Bun idiom to break what would otherwise be a circular dependency (agents.ts imports `validateModelString` from jobs.ts at module load; jobs.ts cannot statically import agents.ts back). Agent load errors are caught so a single broken agent directory cannot kill the cron tick.

**Skills** — `create-agent/SKILL.md` gets a new numbered step (Default model) before the Scheduled tasks loop, and the wizard JSON shape + the final `createAgent({...})` invocation both carry `defaultModel`. `update-agent/SKILL.md` gets a new menu option (`8. Default model`) with its own handler section showing the bun -e snippet shape, and the existing Delete/Done options renumber to 9/10. Mode selection prompt intentionally not added — defaultModel is single-value.

## Test Results

| Suite                          | Pass / Fail |
| ------------------------------ | ----------- |
| src/__tests__/agents.test.ts   | 112 / 0     |
| src/__tests__/jobs.test.ts     | 22 / 0      |
| Full suite                     | 730 / 13    |

22 new assertions added (16 in agents.test.ts, 6 in jobs.test.ts). Pre-existing 13 failures unchanged from Plan 01 baseline.

## Deviations from Plan

None of substance.

- Plan suggested the clear path "remove the marker block or write empty". Chose to strip both the markers AND the `## Default Model` heading so the CLAUDE.md stays visually clean after a clear — prevents orphan empty headings accumulating.
- Plan said loadAgent return type gets a new field; implemented as optional on `AgentContext` rather than a new type, which keeps all existing callers (runner.ts `loadAgentPrompts`) working without changes.

## Self-Check: PASSED

- src/agents.ts contains `CLAUDE_MD_MODEL_START`, `defaultModel` in `AgentCreateOpts`/`AgentContext`, `applyDefaultModelPatch`
- src/jobs.ts `resolveJobModel` contains `await import("./agents")` + `ctx.defaultModel` fallback
- skills/create-agent/SKILL.md contains "Default model" step and `defaultModel: cfg.defaultModel` in the scaffold snippet
- skills/update-agent/SKILL.md contains `8. Default model` menu item with bun -e snippet
- Commits 4a86ca3, bd2f380, f2bd7d4 present in `git log`
- `bun test` reports 730/743 (13 pre-existing failures only)
