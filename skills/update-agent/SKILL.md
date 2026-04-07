---
name: update-agent
description: Use when the user wants to modify an existing agent — change personality, workflow, add or edit a scheduled job, update Discord channels, swap a job's model, or delete the agent. Trigger phrases include "update an agent", "edit agent", "modify agent", "change agent", "/claudeclaw:update-agent", "add a job to <agent>", "remove job from <agent>", "delete agent <name>".
---

# Update Agent

This skill walks the user through updating an existing agent without losing its accumulated MEMORY.md state.

## Invariants (READ THIS FIRST)

> **NEVER read or write `agents/<name>/MEMORY.md`.** It's the agent's accumulated state — preserving it across edits is the entire point of this skill.
>
> **NEVER touch `agents/<name>/session.json`.** Same reason.
>
> The **only** exception is the "Delete agent" menu option, which removes the entire `agents/<name>/` directory by design.
>
> All edits go through helpers in `src/agents.ts` — they're full-file rewrites with marker-aware patching. Do not hand-edit SOUL.md or CLAUDE.md with the Edit tool.

## Tone

Friendly, brief, opinionated. Same vibe as `create-agent`. Acknowledge each answer in a sentence or less and move on.

## Flow

### Step 1 — List agents

If `$ARGUMENTS` already names an agent, skip to Step 3. Otherwise:

```bash
bun -e 'import { listAgents } from "./src/agents"; console.log((await listAgents()).join("\n"));'
```

Show the list and ask "Which one?".

### Step 2 — Pick agent

Capture the chosen name. Validate it exists in the list above.

### Step 3 — Show current state

```bash
bun -e '
import { loadAgent, listAgentJobs } from "./src/agents";
const ctx = await loadAgent("AGENT_NAME");
const jobs = await listAgentJobs("AGENT_NAME");
console.log("SOUL.md (head):");
console.log((await Bun.file(ctx.soulPath).text()).split("\n").slice(0,30).join("\n"));
console.log("\nJobs:");
for (const j of jobs) console.log(`  - ${j.label} (${j.cron}) ${j.enabled ? "" : "[disabled]"} ${j.model ? "model="+j.model : ""}`);
'
```

### Step 4 — Menu loop

Present this menu and **loop until the user picks Done**. One selection at a time.

```
1. Workflow         — rewrite the agent's operating manual
2. Personality      — rewrite the personality block
3. Add job          — add a new scheduled task
4. Edit job         — change cron / trigger / enabled / model on an existing job
5. Remove job       — delete a scheduled task
6. Discord channels — re-set the channel list
7. Data sources     — rewrite the data sources block
8. Delete agent     — nuke the entire agent directory (requires re-typing the name)
9. Done             — exit
```

For each option, ask the relevant follow-up question(s), then run the matching `bun -e` invocation. Use temp JSON files for any multi-line content (workflow, personality, trigger prompts) to keep escaping sane.

#### Option 1 — Workflow

Re-prompt: "What's the new workflow? (multi-line, will replace the existing block entirely)"
Write to `/tmp/claudeclaw-update.json` then:

```bash
bun -e '
import { updateAgent } from "./src/agents";
import { readFileSync } from "fs";
const { workflow } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { workflow });
console.log("workflow updated");
'
```

#### Option 2 — Personality

Same shape as Workflow:

```bash
bun -e '
import { updateAgent } from "./src/agents";
import { readFileSync } from "fs";
const { personality } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { personality });
console.log("personality updated");
'
```

#### Option 3 — Add job

Collect: label (validate via `validateJobLabel`), cron (validate via `parseScheduleToCron`), trigger prompt, model (`default`/`opus`/`haiku` — empty for default).

```bash
bun -e '
import { addJob } from "./src/agents";
import { readFileSync } from "fs";
const j = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await addJob("AGENT_NAME", j.label, j.cron, j.trigger, j.model);
console.log("added " + j.label);
'
```

#### Option 4 — Edit job

List jobs first (via `listAgentJobs`), let the user pick a label, then ask which fields to change. Build a patch object with only the changed fields:

```bash
bun -e '
import { updateJob } from "./src/agents";
import { readFileSync } from "fs";
const { label, patch } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateJob("AGENT_NAME", label, patch);
console.log("updated " + label);
'
```

`patch` may contain any subset of `{ cron, trigger, enabled, model }`.

#### Option 5 — Remove job

List jobs, let the user pick one, **confirm** ("Remove `<label>`? y/n"), then:

```bash
bun -e '
import { removeJob } from "./src/agents";
await removeJob("AGENT_NAME", "LABEL");
console.log("removed");
'
```

#### Option 6 — Discord channels

Re-prompt for the comma-separated list. Parse to array.

```bash
bun -e '
import { updateAgent } from "./src/agents";
import { readFileSync } from "fs";
const { discordChannels } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { discordChannels });
console.log("channels updated");
'
```

#### Option 7 — Data sources

```bash
bun -e '
import { updateAgent } from "./src/agents";
import { readFileSync } from "fs";
const { dataSources } = JSON.parse(readFileSync("/tmp/claudeclaw-update.json", "utf8"));
await updateAgent("AGENT_NAME", { dataSources });
console.log("data sources updated");
'
```

#### Option 8 — Delete agent

This is destructive. Require the user to **re-type the agent name verbatim** as a confirmation guard. If the typed name does not match, abort and return to the menu.

```bash
bun -e '
import { deleteAgent } from "./src/agents";
await deleteAgent("AGENT_NAME");
console.log("deleted");
'
```

This call IS allowed to remove `MEMORY.md` and `session.json` because the entire agent directory is going away.

#### Option 9 — Done

Exit the loop and print a one-line summary of what changed.

## Examples

### Example A — Update Reg's workflow

```
You: /claudeclaw:update-agent reg
Claude: pulling reg's current state...
        [shows SOUL.md head + jobs list]
        what do you want to change?
        1. Workflow  2. Personality  3. Add job  4. Edit job
        5. Remove job  6. Discord  7. Data sources  8. Delete  9. Done
You: 1
Claude: paste the new workflow (multi-line ok)
You: [pastes 30 lines of new operating manual]
Claude: [writes /tmp/claudeclaw-update.json, runs updateAgent]
        ✓ workflow updated. MEMORY.md untouched.
        anything else?
You: 9
Claude: done. reg's workflow has been replaced. one change total.
```

### Example B — Add a new job to Suzy

```
You: /claudeclaw:update-agent suzy
Claude: [lists current state]
        ...
You: 3
Claude: label?
You: weekly-review
Claude: when?
You: every monday at 8am
Claude: [validates → 0 8 * * 1]
        trigger prompt?
You: scan the week's clippings and write a synthesis to MEMORY.md
Claude: model? (default/opus/haiku)
You: opus
Claude: [runs addJob]
        ✓ added weekly-review (0 8 * * 1, model=opus)
        anything else?
You: 9
```
