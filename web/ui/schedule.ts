/**
 * Schedule helpers — preset table, frequency ↔ cron conversion, simple
 * next-run prediction, and frontmatter line surgery for the job .md files.
 *
 * Backend has a hand-rolled line-by-line frontmatter parser (src/jobs.ts),
 * so anything we write back must keep keys flat (`key: value`) and not
 * introduce nested mappings. The PR_HOOKS_SPEC plans to swap to real YAML
 * later; until then we live within the parser's limits.
 */

export interface Preset {
  /** Minutes between firings. */
  minutes: number;
  /** Short label rendered under the slider tick. */
  label: string;
  /** Human-readable single-line description. */
  human: string;
  /** Resulting cron string when this preset is selected. */
  cron: string;
}

/**
 * Slider stops, fastest → slowest. The slider uses log spacing so the gap
 * between 1m and 5m feels comparable to the gap between 1h and 6h.
 */
export const PRESETS: Preset[] = [
  { minutes: 1, label: "1m", human: "Every minute", cron: "* * * * *" },
  { minutes: 5, label: "5m", human: "Every 5 minutes", cron: "*/5 * * * *" },
  { minutes: 10, label: "10m", human: "Every 10 minutes", cron: "*/10 * * * *" },
  { minutes: 15, label: "15m", human: "Every 15 minutes", cron: "*/15 * * * *" },
  { minutes: 30, label: "30m", human: "Every 30 minutes", cron: "*/30 * * * *" },
  { minutes: 60, label: "1h", human: "Every hour", cron: "0 * * * *" },
  { minutes: 120, label: "2h", human: "Every 2 hours", cron: "0 */2 * * *" },
  { minutes: 360, label: "6h", human: "Every 6 hours", cron: "0 */6 * * *" },
  { minutes: 720, label: "12h", human: "Every 12 hours", cron: "0 */12 * * *" },
  { minutes: 1440, label: "daily", human: "Daily at 09:00", cron: "0 9 * * *" },
  { minutes: 10080, label: "weekly", human: "Mondays at 09:00", cron: "0 9 * * 1" },
];

/** Map a cron string back to the matching preset index, or -1 if custom. */
export function presetIndexForCron(cron: string): number {
  const normalized = cron.trim();
  return PRESETS.findIndex((p) => p.cron === normalized);
}

/**
 * Best-effort next-run prediction for a few cron shapes we actually emit:
 *   `* * * * *`           → next minute boundary
 *   `*​/N * * * *`         → next minute where (min % N === 0)
 *   `M * * * *`           → next time minute hits M
 *   `0 *​/H * * *`         → next hour where (hr % H === 0) at minute 0
 *   `M H * * *`           → next H:M (today or tomorrow)
 *   `M H * * D`           → next H:M on day-of-week D (0–6, 0=Sun)
 *
 * Returns null for shapes outside this set — caller renders "—".
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: covers six distinct cron shapes; splitting per-shape would just thread the same `from`/`base` through helpers.
export function nextRunAt(cron: string, from = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  const [min, hr, dom, mon, dow] = parts;
  if (!(min && hr && dom && mon && dow)) {
    return null;
  }

  // Only handle the simple universal cases.
  if (dom !== "*" || mon !== "*") {
    return null;
  }

  const base = new Date(from.getTime());
  base.setSeconds(0, 0);

  // Every minute: just the next minute boundary.
  if (min === "*" && hr === "*" && dow === "*") {
    base.setMinutes(base.getMinutes() + 1);
    return base;
  }

  // */N minutes at all hours: next minute where (m % N === 0).
  const minStep = parseStep(min);
  if (minStep !== null && hr === "*" && dow === "*") {
    const cursor = new Date(base.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
    const wait = (minStep - (cursor.getMinutes() % minStep)) % minStep;
    cursor.setMinutes(cursor.getMinutes() + wait);
    return cursor;
  }

  // Fixed minute "M *​": next time minute reaches M.
  if (/^\d+$/.test(min) && hr === "*" && dow === "*") {
    const target = Number(min);
    const cursor = new Date(base.getTime());
    if (cursor.getMinutes() >= target) {
      cursor.setHours(cursor.getHours() + 1);
    }
    cursor.setMinutes(target);
    return cursor;
  }

  // "0 *​/H * * *": every H hours at minute 0.
  const hrStep = parseStep(hr);
  if (hrStep !== null && /^\d+$/.test(min) && dow === "*") {
    const target = Number(min);
    const cursor = new Date(base.getTime());
    // First candidate: next hour boundary that lands on the step.
    cursor.setMinutes(target, 0, 0);
    if (cursor <= from) {
      cursor.setHours(cursor.getHours() + 1);
    }
    while (cursor.getHours() % hrStep !== 0) {
      cursor.setHours(cursor.getHours() + 1);
    }
    return cursor;
  }

  // Daily at H:M.
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dow === "*") {
    const targetH = Number(hr);
    const targetM = Number(min);
    const cursor = new Date(base.getTime());
    cursor.setHours(targetH, targetM, 0, 0);
    if (cursor <= from) {
      cursor.setDate(cursor.getDate() + 1);
    }
    return cursor;
  }

  // Weekly at H:M on day-of-week D.
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dow)) {
    const targetH = Number(hr);
    const targetM = Number(min);
    const targetDow = Number(dow) % 7;
    const cursor = new Date(base.getTime());
    cursor.setHours(targetH, targetM, 0, 0);
    let delta = (targetDow - cursor.getDay() + 7) % 7;
    if (delta === 0 && cursor <= from) {
      delta = 7;
    }
    cursor.setDate(cursor.getDate() + delta);
    return cursor;
  }

  return null;
}

function parseStep(field: string): number | null {
  // Matches `*/N` where N is a positive integer.
  const m = field.match(/^\*\/(\d+)$/);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * Human-readable countdown like "in 4m 12s" or "in 2h 13m" or "now".
 * Returns null when given null (so the caller can render "—" once).
 */
export function describeWait(target: Date | null, from = new Date()): string | null {
  if (!target) {
    return null;
  }
  const ms = target.getTime() - from.getTime();
  if (ms <= 0) {
    return "now";
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `in ${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `in ${m}m ${s % 60}s`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `in ${h}h ${m % 60}m`;
  }
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

// ---------------------------------------------------------------------------
// Frontmatter line surgery
// ---------------------------------------------------------------------------

/**
 * Match the `---` frontmatter block at the start of a job .md file.
 * Captures: [1] = inner block, [2] = body.
 */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

import { type HookConfig, parseOnBlock } from "./hookConfig";

export interface JobFrontmatter {
  schedule: string;
  recurring: boolean | null;
  notify: "true" | "false" | "error" | null;
  enabled: boolean | null;
  hookConfig: HookConfig | null;
}

/**
 * Read the schedule-relevant fields from a job .md file. Unknown values
 * become null so the editor can present a sensible default without
 * silently rewriting unrelated keys.
 */
export function readFrontmatter(content: string): JobFrontmatter {
  const m = content.match(FRONTMATTER_RE);
  const lines = m ? (m[1] ?? "").split("\n") : [];
  const get = (key: string): string | null => {
    const found = lines.find((l) => l.trim().startsWith(`${key}:`));
    if (!found) {
      return null;
    }
    return found
      .replace(new RegExp(`^\\s*${key}:\\s*`), "")
      .trim()
      .replace(/^["']|["']$/g, "");
  };
  const recurring = get("recurring");
  const notify = get("notify");
  const enabled = get("enabled");
  return {
    schedule: get("schedule") ?? "",
    recurring: recurring === null ? null : recurring.toLowerCase() === "true",
    notify:
      notify === null
        ? null
        : notify === "true" || notify === "false" || notify === "error"
          ? notify
          : null,
    enabled: enabled === null ? null : enabled.toLowerCase() === "true",
    hookConfig: parseOnBlock(content),
  };
}

/**
 * Patch only the keys we know about (schedule / recurring / notify /
 * enabled) inside the existing frontmatter block, preserving every other
 * line untouched. Missing keys are appended. If the file has no
 * frontmatter, a fresh block is prepended.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: line surgery has multiple branches per supported key; rewriting via full YAML is in the PR_HOOKS_SPEC backlog.
export function writeFrontmatter(content: string, patch: Partial<JobFrontmatter>): string {
  const m = content.match(FRONTMATTER_RE);
  const body = m ? (m[2] ?? "") : content;
  const existingBlock = m ? (m[1] ?? "") : "";

  const updates: Record<string, string> = {};
  if (patch.schedule !== undefined) {
    updates.schedule = quote(patch.schedule);
  }
  if (patch.recurring !== undefined && patch.recurring !== null) {
    updates.recurring = String(patch.recurring);
  }
  if (patch.notify !== undefined && patch.notify !== null) {
    updates.notify = patch.notify;
  }
  if (patch.enabled !== undefined && patch.enabled !== null) {
    updates.enabled = String(patch.enabled);
  }

  // Strip out the existing on: block so the scalar-line surgery below
  // doesn't have to reason about nested keys.
  const blockWithoutOn = stripOnBlock(existingBlock);
  const lines = blockWithoutOn.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const keyMatch = line.match(/^\s*([a-zA-Z_]+)\s*:/);
    const key = keyMatch?.[1];
    if (key && key in updates) {
      out.push(`${key}: ${updates[key]}`);
      seen.add(key);
    } else {
      out.push(line);
    }
  }
  for (const key of Object.keys(updates)) {
    if (!seen.has(key)) {
      out.push(`${key}: ${updates[key]}`);
    }
  }

  // Drop a trailing empty line that we may have introduced.
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }

  // Append the `on:` block last, if the caller supplied one. `undefined`
  // means "leave existing on: block alone" — but we already stripped it,
  // so re-parse from the source to restore it untouched.
  let onLines: string[] = [];
  if (patch.hookConfig === undefined) {
    // Preserve any prior on: block verbatim.
    const prior = extractOnBlock(existingBlock);
    if (prior) {
      onLines = prior.split("\n");
    }
  } else if (patch.hookConfig !== null && patch.hookConfig.pr.length > 0) {
    onLines = renderOnBlock(patch.hookConfig);
  }

  const finalLines = [...out, ...onLines];
  return `---\n${finalLines.join("\n")}\n---\n${body}`;
}

/**
 * Find the `on:` section in a frontmatter block and return its text
 * (including the `on:` line, excluding the trailing newline). Returns
 * null when there isn't one.
 */
function extractOnBlock(block: string): string | null {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => /^on\s*:/.test(l));
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "" || /^\s/.test(line)) {
      continue;
    }
    end = i;
    break;
  }
  return lines.slice(start, end).join("\n");
}

function stripOnBlock(block: string): string {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => /^on\s*:/.test(l));
  if (start < 0) {
    return block;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "" || /^\s/.test(line)) {
      continue;
    }
    end = i;
    break;
  }
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  // Drop any trailing blank lines we may have created.
  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }
  return kept.join("\n");
}

/**
 * Render a HookConfig as YAML lines. Structure is fixed (list of
 * mappings with scalar/list values) so we hand-roll it to keep the
 * output deterministic and readable.
 */
// Default values used by parseOnBlock — we keep emitted YAML terse by
// omitting any field that matches its default. Stay in sync with that
// parser; otherwise round-trips silently lose user intent.
const DEFAULT_ACTIONS = ["opened", "synchronize", "reopened"];
const DEFAULT_BRANCH = ["*"];
const SHORTHAND_BRANCH = ["!main"];

function isDefaultList(value: string[], def: string[]): boolean {
  if (value.length !== def.length) {
    return false;
  }
  return value.every((v, i) => v === def[i]);
}

/**
 * Render a HookConfig as YAML lines. Structure is fixed (list of
 * mappings with scalar/list values) so we hand-roll it to keep the
 * output deterministic and readable. Fields at their default value are
 * skipped so saved frontmatter stays terse — no `branch: ["*"]` clutter
 * for the common case.
 *
 * If every rule is "wide open" (user: ["*"], everything else default)
 * we collapse to `on: prs: true` — a single-line shorthand that the
 * parsers accept and round-trip cleanly.
 */
function renderOnBlock(cfg: import("./hookConfig").HookConfig): string[] {
  const commentsActive =
    cfg.comments === true || (typeof cfg.comments === "object" && cfg.comments !== null);

  if (cfg.pr.length === 0 && !commentsActive) {
    return ["on:"];
  }

  const head: string[] = ["on:"];
  if (cfg.comments === true) {
    head.push("  comments: true");
  } else if (typeof cfg.comments === "object" && cfg.comments !== null) {
    // Expanded form: comments:\n    user: [...]
    head.push("  comments:");
    head.push(`    user: ${renderList(cfg.comments.user)}`);
  }

  // Shorthand: a single permissive rule (any repo, anyone, defaults but
  // `branch: ["!main"]`) collapses to `on:\n  prs: true`. Round-trips
  // through the parsers cleanly.
  if (cfg.pr.length === 0) {
    return head;
  }
  if (isFullyOpen(cfg.pr)) {
    return [...head, "  prs: true"];
  }

  const out: string[] = [...head, "  pr:"];
  for (const rule of cfg.pr) {
    let first = true;
    const emit = (key: string, rendered: string) => {
      const prefix = first ? "    - " : "      ";
      out.push(`${prefix}${key}: ${rendered}`);
      first = false;
    };
    emit("repo", renderStringOrList(rule.repo));
    emit("user", renderList(rule.user));
    if (!isDefaultList(rule.action, DEFAULT_ACTIONS)) {
      emit("action", renderList(rule.action));
    }
    if (!isDefaultList(rule.branch, DEFAULT_BRANCH)) {
      emit("branch", renderList(rule.branch));
    }
    if (rule.labels.length > 0) {
      emit("labels", renderList(rule.labels));
    }
    if (rule.draft !== false) {
      emit("draft", renderDraft(rule.draft));
    }
  }
  return out;
}

function isFullyOpen(rules: import("./hookConfig").PrRule[]): boolean {
  if (rules.length !== 1) {
    return false;
  }
  const r = rules[0];
  if (!r) {
    return false;
  }
  const repoWildcard =
    (typeof r.repo === "string" && (r.repo === "*" || r.repo === "*/*")) ||
    (Array.isArray(r.repo) && r.repo.length === 1 && (r.repo[0] === "*" || r.repo[0] === "*/*"));
  return (
    repoWildcard &&
    r.user.length === 1 &&
    r.user[0] === "*" &&
    isDefaultList(r.action, DEFAULT_ACTIONS) &&
    isDefaultList(r.branch, SHORTHAND_BRANCH) &&
    r.labels.length === 0 &&
    r.draft === false
  );
}

function renderStringOrList(v: string | string[]): string {
  if (Array.isArray(v)) {
    return renderList(v);
  }
  return yamlScalar(v);
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "[]";
  }
  return `[${items.map(yamlScalar).join(", ")}]`;
}

function renderDraft(v: boolean | "any"): string {
  if (v === "any") {
    return '"any"';
  }
  return String(v);
}

/**
 * Quote a YAML scalar when it contains characters that would confuse a
 * naive line parser, or is empty. We use double quotes and backslash-
 * escape any embedded double quotes / backslashes.
 */
function yamlScalar(value: string): string {
  if (value === "") {
    return '""';
  }
  if (/^[A-Za-z0-9_\-./]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Quote a cron string only if it contains characters that would confuse
 *  the line parser (currently `*`, `:`, `#`). */
function quote(value: string): string {
  if (value === "") {
    return '""';
  }
  if (/[*:#]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
