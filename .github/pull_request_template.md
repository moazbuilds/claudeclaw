## What this PR does

Describe the change clearly. No scope limit — large refactors, multi-file stacks, and opinionated changes are all welcome here.

## Why

Link to the issue or discussion where this was aligned. If it's a quick fix, a one-liner is fine.

## Validation

- [ ] `bun test` passes locally
- [ ] `bunx tsc --noEmit` is clean
- [ ] Docs or setup guidance affected by this change are updated
- [ ] Manual smoke test run if touching daemon paths

## Plugin versioning

If this PR changes shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, bump the version metadata:

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

- bump `.claude-plugin/plugin.json` when shipped plugin content changes
- bump `.claude-plugin/marketplace.json` when marketplace metadata should reflect the new version

Docs-only and other non-shipped changes do not require these bumps. (CI will tell you if you missed one.)

## Sentrux (optional but appreciated)

If touching core daemon code, paste a brief Sentrux scan summary here. Keep scores above C.
