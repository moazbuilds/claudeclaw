---
phase: 17
status: blocking
created: 2026-04-07
source: live UAT on Hetzner production server (Reg agent creation attempt)
---

# Phase 17 — UAT Gaps (BLOCKING)

Discovered during live testing of `/claudeclaw:create-agent` on the Hetzner server (cwd `/home/claw/project`, source at `/opt/claudeclaw`). All three issues block Phase 17 verification — the wizard cannot successfully scaffold an agent end-to-end as deployed.

## GAP-17-01 — Skill `bun -e` snippets use repo-relative imports (FIXED in this commit)

**Severity:** Blocking
**Status:** Fixed pending deploy

### Symptom
Wizard collects all answers correctly, then on the scaffold step prints:
> "I'm hitting the same permission issue as before — the `.claude/claudeclaw/agents/` directory is protected. I can't create the agent files without explicit permission."

Claude then offers to fall back to direct `Write` (which is the legacy code path the new skill is supposed to bypass).

### Root cause
Every `bun -e` snippet in `skills/create-agent/SKILL.md` and `skills/update-agent/SKILL.md` used a repo-relative import:
```js
import { createAgent, addJob } from "./src/agents";
```
On the server, the systemd service runs from `cwd=/home/claw/project` while the source lives at `/opt/claudeclaw/src/`. The import fails with `Cannot find module './src/agents' from '/home/claw/project/[eval]'`. Claude treats the failure as ambiguous and falls back to direct `Write`/`Edit` on agent files, which Claude Code's built-in protection then blocks. The "permanently sensitive" path Claude reports (`.claude/claudeclaw/agents/`) is hallucinated from the legacy Phase 16 layout still present in earlier conversation context.

### Fix (this commit)
All 14 `bun -e` snippets converted from static `import { X } from "./src/agents"` to dynamic:
```js
const { X } = await import(`${process.env.CLAUDECLAW_ROOT || "."}/src/agents.ts`);
```
- Local dev: `process.env.CLAUDECLAW_ROOT` is unset → falls back to `.` → resolves against repo cwd (unchanged behaviour).
- Server: `CLAUDECLAW_ROOT=/opt/claudeclaw` set in `/usr/local/bin/claudeclaw-start` → resolves to absolute path.

Smoke-tested both paths against `validateAgentName("reg")` → `{valid:true}`.

### Deploy steps
1. Push to `povai/main`
2. Fast-forward `/opt/claudeclaw` (`git pull povai main`)
3. Add `export CLAUDECLAW_ROOT=/opt/claudeclaw` to the launcher block in `/usr/local/bin/claudeclaw-start` (above the `cd /home/claw/project` line so child bun processes inherit it)
4. Restart `claudeclaw.service`
5. Re-run create-agent wizard end-to-end

## GAP-17-02 — Workflow vs per-job Trigger Prompt redundancy

**Severity:** Blocking (UX, but blocks confident sign-off)
**Status:** Open

### Symptom
For single-task agents, the wizard asks the same question twice in different shapes:
- **Q4 (Workflow):** "How does this agent operate? Guidelines, tone, do's and don'ts — mini operating manual."
- **Q7c (Trigger Prompt):** "What should the agent do when this fires?"

The user (Reg UAT, 2026-04-07) wrote a 300-word workflow describing exactly what Reg should do on each daily run, then was asked the trigger prompt question and replied: *"This has already been defined here:"* and pasted the same content verbatim.

### Why it matters
- Wastes user time and patience.
- Creates two sources of truth that can drift (the SOUL.md `## Workflow` block and the job's trigger prompt). Which one wins at runtime?
- Encourages users to abandon the wizard mid-flow.

### Proposed fix
Wizard logic: when the user has provided a non-trivial Workflow AND the agent has exactly one job, **default the trigger prompt to "Run the workflow defined in SOUL.md"** (or actually inline the workflow content) and skip Q7c. Offer "want to override the trigger prompt for this job? (y/n)" as an opt-out for users who genuinely want a different per-job trigger.

Multi-job agents still need per-job trigger prompts since different jobs do different things.

## GAP-17-03 — Network glitch eats wizard acknowledgment, no recovery

**Severity:** Medium-High (fragility, not always reproducible but already happened in UAT)
**Status:** Open

### Symptom
During Reg UAT, a `[Failed: TypeError: network error]` swallowed Claude's acknowledgment of the role answer. The user typed the personality answer next, which Claude (correctly) accepted as Q3 — but with no visible "got it" reply, the user didn't know whether the wizard had advanced. They had to ask "Are you still working on the guidelines?" to confirm state.

### Why it matters
The wizard is stateful but stateless on the user side — when an acknowledgment is dropped, the user has no way to resync without asking Claude. For long wizards (8+ questions) this is a real failure mode.

### Proposed fix
- Echo the captured value at the start of every question: `Got it — role: "Researches Topics..." Next: who are they? Personality (2-4 sentences).`
- After the last question, before scaffolding, print a full "here's everything I have, confirm or amend" review block.
- Persist wizard state to `/tmp/claudeclaw-agent-wizard.json` after EACH answer (not just at the end), so a network glitch / context reset doesn't lose progress.

## GAP-17-04 — Wizard doesn't tell Claude "local cron, not remote schedule"

**Severity:** Blocking (UX, confused Claude on first live test)
**Status:** Open

### Symptom
After Reg was scaffolded on 2026-04-07, the user asked "can you force a run now". Claude replied: *"Hold up — I used the wrong skill. The schedule skill is for remote triggers (cloud-based agents). You want to run the local reg agent job on ClaudeClaw right now."* Claude had reached for the cloud-based `schedule` skill (Vercel remote triggers) because the wizard's "Scheduled tasks" section didn't say "this is a local cron job managed by claudeclaw's in-process cron loop in jobs.ts, NOT a cloud trigger".

### Proposed fix
Add an explicit callout at the top of the Scheduled Tasks section in `skills/create-agent/SKILL.md` and `skills/update-agent/SKILL.md`:

> **IMPORTANT — Jobs are LOCAL cron.** Scheduled tasks here are managed by ClaudeClaw's in-process cron loop (`jobs.ts` → `start.ts:setInterval`). They are NOT the remote `schedule` skill (which uses cloud triggers). Do not invoke the `schedule` skill from this wizard. All job files live at `agents/<name>/jobs/<label>.md` with cron frontmatter.

## GAP-17-05 — No manual "fire now" command for local jobs

**Severity:** Blocking (operational, noticed during Reg UAT)
**Status:** Open

### Symptom
After scaffolding Reg, the user wanted to fire the `daily-content-research` job immediately instead of waiting until 7pm. Claude scanned for `claudeclaw trigger`, `claudeclaw run`, etc. Nothing exists. `start.ts --trigger` is a one-shot startup mode, not a running-daemon RPC. The only way to fire a job today is (a) wait for cron, or (b) shell out to a direct `bun -e` that imports `runner.run()` and invokes the job prompt manually.

### Why it matters
- Every new agent requires a 1-minute-to-24-hour wait before you can see if it actually works
- No way to re-run a failed job without editing the cron expression
- No way to smoke-test a job during development

### Proposed fix
Add `claudeclaw fire <agent>:<label>` (or `claudeclaw run-job <agent> <label>`) CLI command that:
- Loads the matching job from `agents/<agent>/jobs/<label>.md`
- Calls `run(job.name, job.prompt, job.agent)` once (same code path as the cron loop)
- Streams output to stdout; forwards to Discord/Telegram per the job's `notify` frontmatter
- Respects the agent's session (uses `--resume` if the agent has a live session)

Expose same functionality via Discord/Telegram slash command (`/fire reg:daily-content-research`) and Web UI button on each agent's job list.

## GAP-17-06 — Slash command discovery not working from Web UI

**Severity:** Blocking (UX, immediate friction)
**Status:** Open

### Symptom
Live test on 2026-04-07: user typed `/claudeclaw:create-agent` in the web UI chat. Claude replied *"I don't have a `/claudeclaw:create-agent` command, but I can scaffold a new agent using the **create-agent** skill."*

Claude Code IS finding the skill itself (from `~claw/.claude/skills/create-agent/SKILL.md` — symlinked to `/opt/claudeclaw/skills/create-agent`), but NOT the slash command (file at `/opt/claudeclaw/commands/claudeclaw/create-agent.md`). The symlink for commands was only created at the project level (`/home/claw/project/.claude/commands` → `/opt/claudeclaw/commands`), but Claude Code's slash command loader searches user-level `~/.claude/commands/` first.

### Proposed fix
- Create `~claw/.claude/commands/claudeclaw/` symlink (or copy) pointing at `/opt/claudeclaw/commands/claudeclaw/`
- Verify discovery from both Web UI AND Discord/Telegram paths
- Add a claudeclaw install/bootstrap step that wires both user-level AND project-level command/skill symlinks automatically on daemon first run, so deployments don't require manual symlink management

---

## GAP-17-07 — update-agent Workflow/Personality/DataSources are replace-only, no append mode

**Severity:** Blocking (footgun — silent data loss on every edit)
**Status:** Open

### Symptom
Live during Reg UAT on 2026-04-07: user wanted to add a small paragraph to Reg's workflow telling him to use `nanobanana-pro-fallback` for images and `veo` for video. The update-agent wizard's **Option 1 (Workflow)** prompt is *"What's the new workflow? (multi-line, will replace the existing block entirely)"* — the user would have had to re-type or re-paste Reg's entire original 300-word workflow to avoid wiping it, just to add 3 extra sentences.

Same issue applies to **Option 2 (Personality)** and **Option 7 (Data sources)** — all three are destructive replace-only operations with no "append" or "patch" alternative.

### Why it matters
- Silent data loss: user types a short addition, loses the rest without warning
- Forces re-entry of content the user already wrote (error-prone, tedious)
- Makes iterative refinement of agents impractical — every small tweak requires a full rewrite
- Exact same footgun pattern as GAP-17-02 (workflow/trigger redundancy) — both trace to the wizard prescribing total-replacement when partial-edit is what the user actually wants

### Proposed fix
For Workflow / Personality / Data sources (Options 1, 2, 7), add a **mode selection** before the content prompt:

```
How should this be applied?
  a. Append        — add to the existing <section> (keeps everything already there)
  b. Replace       — wipe and rewrite the entire block
  c. Show current  — print the current content so you can edit it in place
```

Default to `a` (append) since it's non-destructive. `c` is helpful when the user wants to see what's there before deciding. `b` stays available for full rewrites.

Implementation:
- `updateAgent()` helper already has the plumbing (it's a patch function). Add an optional `mode: "append" | "replace"` field per patch key (default `"replace"` to preserve existing API, wizard passes `"append"` explicitly).
- For append, the helper concatenates with a blank line separator inside the managed markers (`claudeclaw:workflow:start/end`, etc.).
- Wizard shows the "Show current" view by reading the file between markers and printing a diff-friendly block.

### Related
- GAP-17-02 (workflow/trigger redundancy) shares the same root cause — the wizard assumes whole-block replacement is always what the user wants.
- GAP-17-03 (network glitch swallows acks) compounds this: if an acknowledgment is lost, the user may retype content unnecessarily, multiplying the replace-only data loss risk.

---

## GAP-17-08 — Phase 17 agent jobs diverge from native cron scheduler format (FIXED in this commit)

**Severity:** Blocking — production-critical. Without this fix, **no Phase 17 agent job ever fires via the native cron loop**.
**Status:** Fixed pending deploy + migration

### Symptom
During Reg UAT on 2026-04-07, after scaffolding `agents/reg/jobs/daily-content-research.md` successfully, `loadJobs()` returned **zero jobs**. Reg's 7pm schedule would never fire. The daemon's cron `setInterval` loop (`start.ts:720`) iterates `currentJobs` from `loadJobs()`, so an empty list means no job execution — silently.

### Root cause: parallel format, not reuse
ClaudeClaw already has a working native cron scheduler:
- **Job files:** `.claude/claudeclaw/jobs/*.md`
- **Frontmatter key:** `schedule: <cron>`
- **Loader:** `jobs.ts` `parseJobFile()` — only reads `schedule:`
- **Writer:** Web UI "Add Scheduled Job" form → POSTs to `.claude/claudeclaw/jobs/` with `schedule:` key
- **Executor:** `start.ts:720` `setInterval` tick (runs every 60s)
- **Hot-reload:** every 30s via `start.ts:642`

**Phase 17 wrongly introduced a parallel format** instead of reusing the native scheduler:
- New location: `agents/<name>/jobs/<label>.md` (OK — agent-scoped, sensible)
- New frontmatter key: `cron: <expression>` (**wrong** — native loader only knows `schedule:`)
- New helpers in `agents.ts`: `renderJobFile` and `parseJobFileContent` both use `cron:`

`jobs.ts` `loadJobs()` already has a Phase 17 scan pass for `agents/<name>/jobs/*.md` (wired by plan 17-04), but it calls the *native* `parseJobFile` which only reads `schedule:`. Every Phase 17 job file silently returns `null` from the parser and gets dropped on the floor.

**This should have been caught in Phase 17 integration testing but wasn't** because the plan 17-04 SUMMARY's test only checked that `loadJobs` scanned the new directory, not that it successfully parsed the files the Phase 17 helpers write.

### Fix (this commit)
Change the frontmatter key from `cron:` to `schedule:` in `src/agents.ts`:
- `renderJobFile()` — emits `schedule: ${cron}` instead of `cron: ${cron}`
- `updateJob()` render block — same
- `parseJobFileContent()` — reads `schedule:` as canonical, falls back to `cron:` for legacy Phase 17 files already on disk

TypeScript variable/parameter names remain `cron` internally — only the on-disk frontmatter key changes. All 85 existing tests updated and passing.

### Migration
Any existing Phase 17 agent job files on disk (e.g. `agents/reg/jobs/daily-content-research.md`) need one-time migration:
```bash
sed -i 's/^cron: /schedule: /' agents/*/jobs/*.md
```
Idempotent — only touches lines beginning with `cron: `.

### Architectural note (follow-up, not this commit)
Phase 17's `addJob`/`updateJob`/`removeJob`/`listAgentJobs` helpers should ideally be refactored to be a thin agent-scoped layer over the **same** storage backend as the Web UI's "Add Scheduled Job" — rather than maintaining two parallel code paths that can diverge again. One storage format, one loader, one executor — multiple user-facing surfaces (Web UI form, CLI `addJob`, wizard, update-agent skill). File as follow-up for Phase 19 or post-v1.0.

---

## Verification gate

Phase 17 cannot be marked verified until:
- [x] GAP-17-01 deployed to server, fresh wizard run successfully scaffolds `agents/reg/` with `## Workflow` markers in SOUL.md and `jobs/daily-content-research.md` (verified 2026-04-07 ~19:00 BST)
- [ ] GAP-17-02 fixed in `skills/create-agent/SKILL.md` (single-job workflow reuse) and re-tested
- [ ] GAP-17-03 fixed (per-question echo + final review block + per-step temp-file persistence)
- [ ] GAP-17-04 fixed (local cron vs remote schedule callout in wizard)
- [ ] GAP-17-05 fixed (manual `fire` command — CLI + Discord/Telegram slash + Web UI button)
- [x] GAP-17-06 fixed (new `src/install.ts` module auto-wires `~/.claude/skills/*` + `~/.claude/commands/claudeclaw` symlinks on daemon startup; idempotent, non-destructive, 5 unit tests)
- [ ] GAP-17-07 fixed (update-agent Workflow/Personality/DataSources get append mode, default non-destructive)
- [x] GAP-17-08 fixed (frontmatter key `cron:` → `schedule:` to match native scheduler; migration of existing files; tests updated)

Plan 17-05's SUMMARY and the phase verification step (`gsd-verifier`) are blocked on these.
