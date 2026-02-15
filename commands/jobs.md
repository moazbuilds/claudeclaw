---
description: "Create, list, edit, or delete cron jobs. Triggers: create a job, add a job, new job, schedule a task, schedule a prompt, set up a cron, automate, run on a schedule, recurring task, periodic task, timed task, I want to schedule, I want to create a job, add scheduled task, manage jobs, job list, delete job, remove job, edit job, run job"
---

Manage cron jobs for the heartbeat daemon. Use `$ARGUMENTS` to determine the action.

Parse `$ARGUMENTS` to identify the sub-command. If no arguments are given, list all jobs.

## Sub-commands

### `list` (default when no arguments)

1. List all `.md` files in `.claude/claudeclaw/jobs/`.
2. For each file, read it and display:
   - **Job name** (filename without `.md`)
   - **Schedule** (cron expression from frontmatter)
   - **Prompt** (body text, truncated to 100 chars if long)
3. If no jobs exist, tell the user and show how to create one.

### `create` or `add`

Create a new cron job interactively.

1. Use **AskUserQuestion** to ask:
   - "What should this job be called?" (header: "Job name", options: suggest 2 contextual names based on the project, e.g. "git-summary", "test-runner")
   - "When should it run?" (header: "Schedule", options: "Every hour (0 * * * *)", "Every 6 hours (0 */6 * * *)", "Daily at 9am (0 9 * * *)", "Daily at midnight (0 0 * * *)")

2. Then ask:
   - "What prompt should Claude execute?" (header: "Prompt", options: suggest 2-3 prompts relevant to the project context)

3. Create the job file at `.claude/claudeclaw/jobs/<name>.md` with this exact format:
   ```markdown
   ---
   schedule: "<cron expression>"
   ---
   <prompt>
   ```

4. Confirm creation. Remind the user the daemon hot-reloads jobs every 30 seconds — no restart needed.

### `edit <job-name>`

Edit an existing cron job.

1. Read `.claude/claudeclaw/jobs/<job-name>.md`. If it doesn't exist, list available jobs and ask the user which one to edit.
2. Show the current schedule and prompt.
3. Use **AskUserQuestion** to ask:
   - "What do you want to change?" (header: "Edit", options: "Schedule", "Prompt", "Both")
4. Based on the answer:
   - **Schedule**: Ask for a new cron expression with preset options (same as create).
   - **Prompt**: Ask for a new prompt with the current prompt shown for reference.
   - **Both**: Ask both questions.
5. Write the updated file and confirm.

### `delete` or `remove <job-name>`

Delete a cron job.

1. If no job name given in `$ARGUMENTS`, list all jobs and use **AskUserQuestion** to ask which one to delete.
2. Confirm deletion with **AskUserQuestion**: "Delete job '<name>'? This cannot be undone." (header: "Confirm", options: "Yes, delete it", "No, keep it")
3. If confirmed, delete `.claude/claudeclaw/jobs/<job-name>.md`.
4. Confirm deletion. The daemon will pick up the change on the next hot-reload cycle (within 30s).

### `run <job-name>`

Manually trigger a cron job immediately (useful for testing).

1. Read `.claude/claudeclaw/jobs/<job-name>.md`. If it doesn't exist, list available jobs.
2. Show the job's prompt and ask for confirmation: "Run job '<name>' now?" (header: "Run", options: "Yes", "No")
3. If confirmed, run the prompt by executing:
   ```bash
   bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts run <job-name>
   ```
   If the `run` sub-command is not implemented in the CLI, execute the prompt directly using `claude -p "<prompt>" --output-format text` instead.
4. Show the output to the user.

---

## Reference: Job File Format

Jobs live in `.claude/claudeclaw/jobs/` as markdown files:

```markdown
---
schedule: "0 9 * * *"
daily: true
---
Your prompt here. Claude will run this at the scheduled time.
```

**Cron syntax**: `minute hour day-of-month month day-of-week`

**Timezone-aware**: All cron times are evaluated in the configured `timezone` from `settings.json`. E.g. `0 9 * * *` with `timezone: "UTC+2"` fires at 9:00 AM local time.

**`daily`**: If `true`, the job repeats on schedule. If omitted or `false`, the job is **one-shot** — the schedule is removed from the file after it runs.

| Expression       | Meaning                  |
|------------------|--------------------------|
| `* * * * *`      | Every minute             |
| `0 * * * *`      | Every hour               |
| `*/15 * * * *`   | Every 15 minutes         |
| `0 9 * * *`      | Daily at 9:00 AM         |
| `0 9 * * 1-5`    | Weekdays at 9:00 AM     |
| `0 0 * * *`      | Daily at midnight        |
| `0 */6 * * *`    | Every 6 hours            |
| `0 9,18 * * *`   | At 9 AM and 6 PM        |

The daemon checks cron expressions every 60 seconds and hot-reloads job files every 30 seconds.
