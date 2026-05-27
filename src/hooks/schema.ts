/**
 * Schema for the `on:` block inside a job's YAML frontmatter.
 *
 *   on:
 *     pr:
 *       repo: org/repo            # or [org/repo, org/other]
 *       user: ["*", "!*[bot]"]    # include/exclude globs, evaluated in order
 *       action: [opened, synchronize, reopened]
 *       branch: [main, !release/*]
 *       labels: [ready-for-review]
 *       draft: false              # false (default), true, or "any"
 *
 * Defaults are picked to be safe-by-default:
 *  - `user` has no default — a rule with no user list never matches, so
 *    forks from random accounts don't trigger jobs.
 *  - `action` defaults to common write events.
 *  - `draft` defaults to false (skip drafts).
 */

export type StringOrList = string | string[];

export interface PrRule {
  repo: string | string[];
  user: string[]; // required, but we'll surface a clearer error if missing
  action: string[];
  branch: string[];
  labels: string[];
  draft: boolean | "any";
}

export interface CommentRule {
  /** Glob list (include/exclude semantics same as PrRule.user) matched
   *  against the commenter's GitHub login. */
  user: string[];
}

export interface HookConfig {
  pr: PrRule[];
  /** Fire on review/comment/suggestion events across the whole tailnet's
   *  repos. Triggers on `issue_comment`, `pull_request_review`, and
   *  `pull_request_review_comment`.
   *
   *  - `true` (or `{ user: ["*"] }`) → any commenter, including bots
   *  - `{ user: ["*", "!*[bot]"] }` → humans only
   *  - `{ user: ["*[bot]"] }`       → bots only
   *  - `false` / unset              → don't fire on comments
   */
  comments?: boolean | CommentRule;
}

/**
 * Parse the raw `on` value from a job's frontmatter into a normalized
 * HookConfig. Returns null if there's no `on:` block. Throws with a
 * descriptive message if the block is malformed.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shape-validation has a branch per supported field.
export function parseHookConfig(raw: unknown): HookConfig | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`\`on:\` must be a mapping (got ${typeName(raw)})`);
  }
  const obj = raw as Record<string, unknown>;

  // Top-level shorthands.
  const comments = parseComments(obj.comments);

  // `prs: true` desugars to a single rule that matches any PR not
  // targeting main (skips release/landing PRs, which are usually noise
  // for code-review automation).
  if (obj.prs === true || obj.prs === "true") {
    const cfg: HookConfig = { pr: [fullyOpenPrRule()] };
    if (comments !== false) {
      cfg.comments = comments;
    }
    return cfg;
  }

  const pr = obj.pr;
  const prRules: PrRule[] = [];
  if (pr !== undefined) {
    const list = Array.isArray(pr) ? pr : [pr];
    for (let i = 0; i < list.length; i++) {
      try {
        prRules.push(normalizePrRule(list[i]));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`on.pr[${i}]: ${msg}`);
      }
    }
  }
  const cfg: HookConfig = { pr: prRules };
  if (comments !== false) {
    cfg.comments = comments;
  }
  return cfg;
}

/** Normalize the `on.comments` field. Accepts:
 *  - `true` / `"true"`     → all commenters (treat as boolean true)
 *  - `false` / unset       → off (return false)
 *  - `{ user: [...] }`     → filter by user globs
 *  Returns `false` for off, `true` for unfiltered, or a CommentRule. */
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
      throw new Error("`on.comments.user` must list at least one glob");
    }
    return { user };
  }
  throw new Error(`\`on.comments\` must be a boolean or { user: [...] }, got ${typeName(raw)}`);
}

function fullyOpenPrRule(): PrRule {
  return {
    repo: "*/*",
    user: ["*"],
    action: [...DEFAULT_PR_ACTIONS],
    // Skip PRs targeting main — release/landing PRs are usually noise
    // for code-review automation. Users can override by writing the
    // expanded `pr:` form.
    branch: ["!main"],
    labels: [],
    draft: false,
  };
}

const DEFAULT_PR_ACTIONS = ["opened", "synchronize", "reopened"];

function normalizePrRule(raw: unknown): PrRule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`expected a mapping (got ${typeName(raw)})`);
  }
  const obj = raw as Record<string, unknown>;
  const repo = requireStringOrList(obj.repo, "repo");
  const user = asList(obj.user);
  if (user.length === 0) {
    throw new Error(
      '`user:` is required and must list at least one glob (use `["*", "!*[bot]"]` ' +
        "for everyone except bots — but be careful on public repos)",
    );
  }
  const action = obj.action === undefined ? DEFAULT_PR_ACTIONS : asList(obj.action);
  const branch = obj.branch === undefined ? ["*"] : asList(obj.branch);
  const labels = obj.labels === undefined ? [] : asList(obj.labels);
  const draftRaw = obj.draft;
  let draft: boolean | "any" = false;
  if (draftRaw === true || draftRaw === "true") {
    draft = true;
  } else if (draftRaw === "any") {
    draft = "any";
  }
  return { repo, user, action, branch, labels, draft };
}

function requireStringOrList(v: unknown, key: string): string | string[] {
  if (typeof v === "string") {
    return v;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  throw new Error(`\`${key}:\` must be a string or list of strings`);
}

function asList(v: unknown): string[] {
  if (v === undefined) {
    return [];
  }
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  throw new Error("expected a string or list of strings");
}

function typeName(v: unknown): string {
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "list";
  }
  return typeof v;
}
