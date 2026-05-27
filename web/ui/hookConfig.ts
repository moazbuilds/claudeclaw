/**
 * Client-side mirror of the `on:` hook-config schema.
 *
 * The server-side source of truth is `src/hooks/schema.ts`. Types and
 * defaults must stay in sync. We can't import that file from web because
 * it's wired into the daemon — so we mirror the shape here and re-parse
 * the YAML frontmatter on the client.
 */

import { parse as parseYaml } from "yaml";

export type DraftValue = boolean | "any";

export interface PrRule {
  repo: string | string[];
  user: string[];
  action: string[];
  branch: string[];
  labels: string[];
  draft: DraftValue;
}

export interface CommentRule {
  /** Glob list matched against the commenter's login. Include/exclude
   *  via `!`-prefix mirrors PrRule.user. */
  user: string[];
}

export interface HookConfig {
  pr: PrRule[];
  /** Fire on review/comment/suggestion events.
   *  - `true`              → any commenter (including bots)
   *  - `{ user: ["*"] }`   → same as `true`, in explicit form
   *  - `{ user: ["*", "!*[bot]"] }` → humans only
   *  - `{ user: ["*[bot]"] }`       → bots only
   */
  comments?: boolean | CommentRule;
}

export const DEFAULT_PR_ACTIONS = ["opened", "synchronize", "reopened"];

export const ALL_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "closed",
  "edited",
  "labeled",
  "unlabeled",
  "ready_for_review",
  "converted_to_draft",
];

/** Best-effort defaults for a new rule. */
export function defaultPrRule(): PrRule {
  return {
    repo: "",
    user: ["*", "!*[bot]"],
    action: [...DEFAULT_PR_ACTIONS],
    branch: ["*"],
    labels: [],
    draft: false,
  };
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse the `on:` block out of a job's frontmatter. Returns null when:
 * - no frontmatter present
 * - no `on:` key
 * - YAML is malformed (silently — the editor falls back to "Add PR trigger")
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch handles a distinct on-block shape (no frontmatter / no on / shorthand / explicit rules); flattening would lose the structure.
export function parseOnBlock(content: string): HookConfig | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    return null;
  }
  const block = m[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const on = (parsed as Record<string, unknown>).on;
  if (on === undefined || on === null) {
    return null;
  }
  if (typeof on !== "object" || Array.isArray(on)) {
    return null;
  }
  const onObj = on as Record<string, unknown>;
  const comments = parseComments(onObj.comments);

  // Shorthand: `prs: true` means "any PR from any user on any repo,
  // default actions, but skip PRs targeting main" — release/landing
  // PRs are usually noise for code-review automation.
  if (onObj.prs === true || onObj.prs === "true") {
    const cfg: HookConfig = { pr: [fullyOpenPrRule()] };
    if (comments !== false) {
      cfg.comments = comments;
    }
    return cfg;
  }

  const pr = onObj.pr;
  const rules: PrRule[] = [];
  if (pr !== undefined) {
    const list = Array.isArray(pr) ? pr : [pr];
    for (const raw of list) {
      const rule = normalizeRule(raw);
      if (rule) {
        rules.push(rule);
      }
    }
  }
  const cfg: HookConfig = { pr: rules };
  if (comments !== false) {
    cfg.comments = comments;
  }
  return cfg;
}

function parseComments(raw: unknown): boolean | CommentRule {
  if (raw === true || raw === "true") {
    return true;
  }
  if (raw === false || raw === "false" || raw === null || raw === undefined) {
    return false;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const user = asList(obj.user);
    if (user.length === 0) {
      return false;
    }
    return { user };
  }
  return false;
}

/** Shorthand-expanded "match any PR" rule. Stays in sync with the
 *  shorthand renderer in schedule.ts → renderOnBlock. */
function fullyOpenPrRule(): PrRule {
  return {
    repo: "*/*",
    user: ["*"],
    action: [...DEFAULT_PR_ACTIONS],
    branch: ["!main"],
    labels: [],
    draft: false,
  };
}

function normalizeRule(raw: unknown): PrRule | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const repo = asStringOrList(obj.repo) ?? "";
  const user = asList(obj.user);
  const action = obj.action === undefined ? [...DEFAULT_PR_ACTIONS] : asList(obj.action);
  const branch = obj.branch === undefined ? ["*"] : asList(obj.branch);
  const labels = obj.labels === undefined ? [] : asList(obj.labels);
  let draft: DraftValue = false;
  const d = obj.draft;
  if (d === true || d === "true") {
    draft = true;
  } else if (d === "any") {
    draft = "any";
  }
  return { repo, user, action, branch, labels, draft };
}

function asStringOrList(v: unknown): string | string[] | null {
  if (typeof v === "string") {
    return v;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  return null;
}

function asList(v: unknown): string[] {
  if (v === undefined || v === null) {
    return [];
  }
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}
