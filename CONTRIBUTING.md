# Contributing to ClaudeClaw+

All ideas welcome. Big PRs, refactors, opinionated reorganisations, new features — bring them. The only rule is we talk first and code second.

---

## Before opening a PR

Open an [issue](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues) or [discussion](https://github.com/TerrysPOV/ClaudeClaw-Plus/discussions) first. Describe what you want to build and why. This keeps wasted effort near zero — if there's an existing design decision or conflict with in-progress work, better to know before you spend a week coding.

For small, obviously-scoped changes (typos, single-function fixes, docs updates) you can skip this and go straight to a PR.

---

## Scope expectations

**Large, multi-file PRs are fine.** Multi-stage feature stacks are fine. We'd rather merge ambitious work than reject it for size.

If your change is the kind of thing that upstream would consider too heavy or opinionated for the lightweight core, that's exactly what ClaudeClaw+ is for. This is the right place.

---

## Validation checklist

Before opening a PR:

- [ ] `bun test` passes locally
- [ ] `bunx tsc --noEmit` is clean
- [ ] Any docs or setup guidance affected by the change is updated
- [ ] If touching core daemon paths (`src/`, `commands/`): run a quick manual smoke test

---

## Plugin version bumps (CI-enforced)

If your PR changes shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, the plugin metadata version **must** be bumped. The CI checks will fail if you skip this.

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

Typical rule:
- bump `.claude-plugin/plugin.json` when shipped plugin content changes
- bump `.claude-plugin/marketplace.json` when marketplace metadata should reflect the new version

Docs-only and other non-shipped changes do not require these bumps.

---

## Structural health (Sentrux)

If your PR touches core daemon code, run a Sentrux scan before marking it ready for review:

```
/claudeclaw:start  →  run scan in Claude Code session
```

Or via MCP: `mcp__plugin_sentrux_sentrux__scan`. Keep scores above C. Flag any dimension that drops below — include the report in your PR description.

---

## Syncing with upstream

ClaudeClaw+ stays aligned with [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) via a daily automated sync. The `.github/workflows/sync-upstream.yml` workflow runs at 07:00 UTC and opens a PR if there are new commits upstream.

**If you see a PR titled "chore: sync upstream":** that's the robot. Review the diff, resolve conflicts if any, and merge. Conflicts are expected when Plus has diverged from upstream in the same files — resolve them manually and document why.

**If you're working on a branch:** rebase onto `main` before opening your PR to minimise merge surface.

---

## Governance and policy code

Features under `src/governance/`, `src/policy/`, or anything touching the tool-call evaluation path require extra care — these affect every Claude invocation in the daemon. Document your invariants. Tests are not optional here.

---

## Proposing features for upstream

Found something in Plus that you think belongs in the lightweight core too? Open a PR upstream at [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) and link it from here. @moazbuilds makes the call on what fits.

---

## Code of conduct

Be decent. Critique code, not people. If something isn't clear, ask — don't assume the worst.

---

## Questions?

Open a [discussion](https://github.com/TerrysPOV/ClaudeClaw-Plus/discussions) or ping [@TerrysPOV](https://github.com/TerrysPOV) in an issue.
