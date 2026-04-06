---
name: create-agent
description: Use when the user wants to create a new agent teammate, scaffold a scheduled Claude persona, or asks to "create an agent", "new agent", "add an agent", "scaffold an agent", "build an agent", "make an agent", or "/claudeclaw:create-agent". Trigger phrases include "I want an agent that", "create a teammate", "new agent persona", "scheduled claude agent".
---

# Create Agent

Wizard for scaffolding a new ClaudeClaw agent — a focused Claude persona with its own identity, soul, memory, session, and optional cron schedule.

You are guiding the user through creating a teammate. Be conversational, warm, and direct. **Ask one question at a time.** Wait for the answer before moving on. **DO NOT dump all questions at once.** This is a wizard, not a form.

## Tone

Match the vibe of `skills/create-skill/SKILL.md`: friendly, brief, opinionated. You're texting a friend who happens to be brilliant. No filler, no walls of text. Acknowledge each answer in a sentence or less, then move to the next question.

## The Six Questions

Ask these in order, one at a time:

### 1. Name (kebab-case)

Ask: "What should we call them? (kebab-case — lowercase, hyphens only, like `daily-digest` or `suzy-v2`)"

**Validate immediately.** Run this in a Bash tool call:

```bash
bun -e "import {validateAgentName} from './src/agents'; const v = validateAgentName('USER_INPUT'); console.log(JSON.stringify(v));"
```

If `valid: false`, tell the user the error in one line and re-ask. Common rejects: capitals (`Suzy`), spaces, starting with a digit, or the agent already existing.

### 2. Role (one line)

Ask: "What does this agent do? One line — what's their job?"

Free text. Just capture it.

### 3. Personality (2–4 sentences)

Ask: "Who are they? Give me 2–4 sentences on their personality and vibe."

Free text. This becomes their SOUL.md.

### 4. Schedule

Ask: "When should they run? Natural language works (`every weekday at 9am`, `daily at 6pm`, `hourly`), raw cron is fine, or `none` for ad-hoc only."

If the user says `none` or anything empty, skip cron and remember `schedule = undefined`. Otherwise **validate** by running:

```bash
bun -e "import {parseScheduleToCron} from './src/agents'; console.log(parseScheduleToCron('USER_INPUT'));"
```

If output is `null`, tell the user it didn't parse and re-ask with examples. Otherwise note the cron string and move on.

### 5. Discord channels

Ask: "Any Discord channels they should know about? Comma-separated (`#content,#research`) or `none`."

Parse comma-separated into an array. `none` → empty array. This is metadata only for now (Phase 16) — gets written into the agent's CLAUDE.md.

### 6. Data sources

Ask: "What information sources do they pull from? (RSS feeds, APIs, files, websites — free text, or `none`)"

Free text.

## Scaffold

Once all six answers are in, scaffold the agent by calling `createAgent()` from `src/agents.ts` via a Bash tool invocation. **Do not use the Write tool for the agent files** — `createAgent()` handles all file generation, the job file, memory, and `.gitignore` in one shot.

Use this pattern (single line, escape carefully):

```bash
bun -e "import {createAgent} from './src/agents'; const ctx = await createAgent({name:'NAME',role:'ROLE',personality:'PERSONALITY',schedule:'SCHEDULE_OR_UNDEFINED',discordChannels:['#chan1','#chan2'],dataSources:'SOURCES'}); console.log(JSON.stringify(ctx, null, 2));"
```

Notes:
- If schedule is `none`, omit the `schedule` field entirely (don't pass an empty string).
- If discordChannels is empty, pass `[]`.
- Escape single quotes in personality/role with care; if the text is gnarly, write it to a temp JSON file and read it in the snippet instead.

## On Success

Print a short summary:

```
✓ Agent <name> created.

Files:
  agents/<name>/IDENTITY.md
  agents/<name>/SOUL.md
  agents/<name>/CLAUDE.md
  agents/<name>/MEMORY.md
  .claude/claudeclaw/jobs/<name>.md   ← only if scheduled

Try it:
  claudeclaw send --agent <name> "say hello"

<if scheduled:>
Scheduled: <cron> — will fire on the daemon's next tick.
</if>
```

Then ask if they want to tweak IDENTITY.md or SOUL.md before they take it for a spin.

## On Failure

If `createAgent()` throws (duplicate name, bad schedule, fs error), surface the error verbatim, suggest a fix, and offer to retry from the failing step. Don't restart the whole wizard.
