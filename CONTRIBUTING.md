# Contributing to ClaudeClaw

Thanks for contributing. ClaudeClaw is a lightweight, open-source Claude Code daemon — keep that in mind when choosing where your work belongs.

---

## Where does your contribution belong?

Not everything should come here. ClaudeClaw has a sister project, [**ClaudeClaw+**](https://github.com/TerrysPOV/ClaudeClaw-Plus), for heavier and more opinionated work. Use this table to decide:

| This contribution is... | Contribute to |
|---|---|
| A bug fix or small improvement | **ClaudeClaw** (you're in the right place) |
| A new adapter or integration | **ClaudeClaw** |
| Lightweight and broadly useful | **ClaudeClaw** |
| A new subsystem (governance, orchestration, policy, persistent memory) | **[ClaudeClaw+](https://github.com/TerrysPOV/ClaudeClaw-Plus)** |
| A large architectural change that adds significant runtime weight | **ClaudeClaw+** |
| Something opinionated that most users wouldn't opt into | **ClaudeClaw+** |

ClaudeClaw+ syncs from this repo daily, so everything here lands there too. If you're unsure, open an issue on either repo and we'll point you in the right direction.

---

## Before opening a PR

- Check the [open issues](https://github.com/moazbuilds/claudeclaw/issues) and existing PRs to avoid duplication
- For anything beyond a small fix, open an issue first to discuss the approach
- Keep the "lightweight" principle in mind: ClaudeClaw runs on low-spec machines, so avoid adding heavy dependencies or new long-lived processes without a strong reason

---

## Validation

Before opening a PR:

- [ ] Run the relevant checks locally
- [ ] Update any docs or setup guidance affected by your change

---

## Plugin version bumps (CI-enforced)

If your PR changes shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, bump the version metadata:

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

Typical rule:
- bump `.claude-plugin/plugin.json` when shipped plugin content changes
- bump `.claude-plugin/marketplace.json` when marketplace metadata should reflect the new version

Docs-only and other non-shipped changes do not require these bumps. (CI will tell you if you missed one.)

---

## Code of conduct

Be decent. Critique code, not people.
