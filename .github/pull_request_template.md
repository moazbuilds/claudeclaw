## Summary

Describe the change and why it is needed.

## Validation

- [ ] I ran the relevant checks locally
- [ ] I updated any docs or setup guidance affected by this change

## Plugin Versioning

If this PR changes shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, version metadata may also need to be bumped.

Run as needed:

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

Typical rule:
- bump `.claude-plugin/plugin.json` when shipped plugin content changes
- bump `.claude-plugin/marketplace.json` when marketplace metadata should reflect the new shipped version

Docs-only and other non-shipped changes do not require these bumps.
