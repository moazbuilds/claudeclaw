# Handoff: Recreate Closed PR #58

## Goal
Recreate the useful part of closed PR `#58` on top of current `master` without carrying over the stale or unused parts of the original branch.

## Branch
`fix/surface-real-cli-errors`

## Original PR
- Closed PR: `#58`
- Original commit: `2bc524e`
- Problem statement: Claude CLI sometimes exits non-zero with the human-readable error message in JSON stdout rather than stderr, causing chat bridges to show `Unknown error`.

## Scope Chosen
Keep only the narrow behaviour that is still useful today:
- add `extractErrorDetail()` in `src/messaging.ts`
- use it in:
  - `src/commands/start.ts`
  - `src/commands/telegram.ts`
  - `src/commands/discord.ts`
- add a focused Bun test file:
  - `src/messaging.test.ts`

Explicitly dropped from the old PR:
- `describeProvider()`
- `isProviderStatusQuery()`
- `isModelChangeRequest()`
- `authoritativeProviderReply()`
- `extractReactionDirective()`

Those were unused in the original PR and were part of the review feedback asking for a narrower branch.

## Changes Already Made
- Added `src/messaging.ts` with `extractErrorDetail()`
- Updated the three error-reporting call sites to use `extractErrorDetail()`
- Added `src/messaging.test.ts` covering:
  - `stderr` present
  - JSON stdout with `is_error/result`
  - raw stdout fallback
- Folded in the minimal `parseSettings(raw, discordUserIds?)` signature fix from the known config issue so `bunx tsc --noEmit` can pass on this branch

## Validation To Run
From repo root:

```bash
bun install
bun test src/messaging.test.ts
bunx tsc --noEmit
```

If anything else fails, check whether it is unrelated existing repo noise or caused by this branch.

## Suggested PR Title
`fix: surface real Claude CLI errors instead of Unknown error`

## Suggested PR Description
This supersedes closed PR `#58`.

Claude CLI sometimes exits non-zero with the real human-readable error detail in JSON stdout rather than stderr. This branch adds a small shared helper, `extractErrorDetail()`, and uses it in the Telegram, Discord, and daemon forwarding error paths so auth/quota/runtime failures surface the actual message instead of `Unknown error`.

The branch is intentionally narrower than the original PR: it keeps only the error-detail extraction behaviour that is used today and drops the unused shared messaging helpers from the abandoned branch.

## Suggested Follow-up Checks
- Confirm Telegram auth/quota errors now surface the parsed message
- Confirm Discord auth/quota errors now surface the parsed message
- Confirm forwarded daemon heartbeat/job failures use the parsed message
