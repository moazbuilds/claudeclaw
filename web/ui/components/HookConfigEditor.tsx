/**
 * Editor for the `on.pr` hook-config block inside a job's YAML frontmatter.
 *
 * Renders one card per PrRule with editors for repo / user / action /
 * branch / labels / draft. Mutations bubble up via `onChange` — the parent
 * is responsible for persisting the resulting HookConfig back into the
 * job's frontmatter string (via writeFrontmatter in schedule.ts).
 */

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  ALL_PR_ACTIONS,
  type DraftValue,
  defaultPrRule,
  type HookConfig,
  type PrRule,
} from "../hookConfig";

interface PillListProps {
  label: string;
  items: string[];
  placeholder: string;
  /** When true, items prefixed with `!` are styled as excludes. */
  supportsExclude?: boolean;
  onChange: (next: string[]) => void;
  hint?: string;
  warn?: boolean;
}

function PillList({
  label,
  items,
  placeholder,
  supportsExclude,
  onChange,
  hint,
  warn,
}: PillListProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }
    onChange([...items, trimmed]);
    setDraft("");
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div className="text-xs font-medium mb-1 flex items-center gap-2">
        <span>{label}</span>
        {warn && <span className="badge badge-warning badge-xs">required</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item, idx) => {
          const isExclude = supportsExclude && item.startsWith("!");
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: pill order is significant; index is a stable id while the list is rendered.
              key={`${idx}:${item}`}
              className={`badge gap-1 font-mono text-xs ${
                isExclude ? "badge-outline badge-error" : "badge-ghost"
              }`}
            >
              {item}
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${item}`}
                className="opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          type="text"
          spellCheck={false}
          className="input input-bordered input-xs font-mono w-40"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && draft === "" && items.length > 0) {
              e.preventDefault();
              remove(items.length - 1);
            }
          }}
          onBlur={commit}
          placeholder={placeholder}
        />
      </div>
      {hint && <div className="text-[11px] text-base-content/50 mt-1">{hint}</div>}
    </div>
  );
}

function repoString(repo: string | string[]): string {
  return Array.isArray(repo) ? repo.join(", ") : repo;
}

function parseRepo(input: string): string | string[] {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] ?? "";
  }
  return parts;
}

function formatActions(actions: string[]): string {
  if (actions.length === 0) {
    return "no actions";
  }
  if (actions.length === 1) {
    return actions[0] ?? "";
  }
  if (actions.length === 2) {
    return `${actions[0]} or ${actions[1]}`;
  }
  return `${actions.slice(0, -1).join(", ")}, or ${actions[actions.length - 1]}`;
}

function formatUsers(users: string[]): string {
  if (users.length === 0) {
    return "nobody";
  }
  const includes = users.filter((u) => !u.startsWith("!"));
  const excludes = users.filter((u) => u.startsWith("!")).map((u) => u.slice(1));
  const incPart = includes.length > 0 ? includes.join(", ") : "nobody";
  if (excludes.length === 0) {
    return incPart;
  }
  return `${incPart} except ${excludes.join(", ")}`;
}

function formatBranches(branches: string[]): string {
  if (branches.length === 0) {
    return "no branches";
  }
  if (branches.length === 1 && branches[0] === "*") {
    return "any base branch";
  }
  return branches.join(", ");
}

function describeRule(rule: PrRule): string {
  const repoText = repoString(rule.repo) || "(repo unset)";
  const actionText = formatActions(rule.action);
  const userText = formatUsers(rule.user);
  const branchText = formatBranches(rule.branch);
  const labelText = rule.labels.length > 0 ? ` with label ${rule.labels.join(", ")}` : "";
  const draftText =
    rule.draft === true ? " (drafts only)" : rule.draft === "any" ? " (drafts and ready PRs)" : "";
  return `Fires when ${repoText} sees ${actionText} from ${userText} on ${branchText}${labelText}${draftText}.`;
}

function RuleCard({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: PrRule;
  index: number;
  onChange: (next: PrRule) => void;
  onRemove: () => void;
}) {
  const repoBlank = repoString(rule.repo).trim() === "";
  const userBlank = rule.user.length === 0;

  function toggleAction(action: string) {
    if (rule.action.includes(action)) {
      onChange({ ...rule, action: rule.action.filter((a) => a !== action) });
    } else {
      onChange({ ...rule, action: [...rule.action, action] });
    }
  }

  function setDraft(d: DraftValue) {
    onChange({ ...rule, draft: d });
  }

  return (
    <div className="card card-bordered bg-base-200/40">
      <div className="card-body p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold">Rule {index + 1}</h4>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onRemove}
            aria-label={`Remove rule ${index + 1}`}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>

        <div>
          <div className="text-xs font-medium mb-1 flex items-center gap-2">
            <span>Repo</span>
            {repoBlank && <span className="badge badge-warning badge-xs">required</span>}
          </div>
          <input
            type="text"
            spellCheck={false}
            className="input input-bordered input-sm font-mono w-full"
            value={repoString(rule.repo)}
            onChange={(e) => onChange({ ...rule, repo: parseRepo(e.target.value) })}
            placeholder="org/repo, org/* (comma-separated)"
          />
        </div>

        <PillList
          label="User"
          items={rule.user}
          placeholder="*, !*[bot]"
          supportsExclude
          warn={userBlank}
          hint="Order matters. Prefix with ! to exclude."
          onChange={(next) => onChange({ ...rule, user: next })}
        />

        <div>
          <div className="text-xs font-medium mb-1">Action</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_PR_ACTIONS.map((action) => {
              const on = rule.action.includes(action);
              return (
                <button
                  key={action}
                  type="button"
                  onClick={() => toggleAction(action)}
                  aria-pressed={on}
                  className={`btn btn-xs ${on ? "btn-primary" : "btn-ghost"}`}
                >
                  {action}
                </button>
              );
            })}
          </div>
        </div>

        <PillList
          label="Branch"
          items={rule.branch}
          placeholder="main, release/*"
          supportsExclude
          onChange={(next) => onChange({ ...rule, branch: next })}
        />

        <PillList
          label="Labels"
          items={rule.labels}
          placeholder="ready-for-review"
          onChange={(next) => onChange({ ...rule, labels: next })}
        />

        <div>
          <div className="text-xs font-medium mb-1">Draft PRs</div>
          <div className="join">
            {(
              [
                { v: false as DraftValue, label: "Skip drafts" },
                { v: true as DraftValue, label: "Drafts only" },
                { v: "any" as DraftValue, label: "Any" },
              ] as const
            ).map((opt) => (
              <button
                key={String(opt.v)}
                type="button"
                aria-pressed={rule.draft === opt.v}
                onClick={() => setDraft(opt.v)}
                className={`btn btn-xs join-item ${
                  rule.draft === opt.v ? "btn-primary" : "btn-ghost"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="text-xs text-base-content/70 italic pt-1 border-t border-base-300">
          {describeRule(rule)}
        </div>
      </div>
    </div>
  );
}

type DraftPreset = "open" | "draft" | "any";
type CommenterPreset = "human" | "bot" | "any";

/** Build a permissive PR rule that fires on every push to every PR
 *  (opened + synchronize + reopened) on any repo, with the chosen draft
 *  filter. Used by the "On all PR commits" presets. */
function prCommitsPreset(d: DraftPreset): PrRule {
  return {
    repo: "*/*",
    user: ["*"],
    action: ["opened", "synchronize", "reopened"],
    branch: ["!main"],
    labels: [],
    draft: d === "any" ? "any" : d === "draft",
  };
}

/** Comment-event filter by author class. */
function commentsPreset(c: CommenterPreset): boolean | { user: string[] } {
  if (c === "any") {
    return true;
  }
  if (c === "human") {
    return { user: ["*", "!*[bot]"] };
  }
  return { user: ["*[bot]"] };
}

/** What's currently active for each preset row, so the right pill is
 *  highlighted. Returns null if nothing matches the preset shape. */
function activePrPreset(rules: PrRule[]): DraftPreset | null {
  if (rules.length !== 1) {
    return null;
  }
  const r = rules[0];
  if (!r) {
    return null;
  }
  const repo = Array.isArray(r.repo) ? r.repo.join(",") : r.repo;
  const actionMatch =
    r.action.length === 3 &&
    r.action.includes("opened") &&
    r.action.includes("synchronize") &&
    r.action.includes("reopened");
  if (
    repo !== "*/*" ||
    r.user.length !== 1 ||
    r.user[0] !== "*" ||
    !actionMatch ||
    r.labels.length !== 0
  ) {
    return null;
  }
  if (r.draft === false) {
    return "open";
  }
  if (r.draft === true) {
    return "draft";
  }
  if (r.draft === "any") {
    return "any";
  }
  return null;
}

function activeCommentPreset(c: HookConfig["comments"]): CommenterPreset | null {
  if (c === true) {
    return "any";
  }
  if (typeof c !== "object" || c === null) {
    return null;
  }
  const u = c.user;
  if (u.length === 2 && u[0] === "*" && u[1] === "!*[bot]") {
    return "human";
  }
  if (u.length === 1 && u[0] === "*[bot]") {
    return "bot";
  }
  if (u.length === 1 && u[0] === "*") {
    return "any";
  }
  return null;
}

export function HookConfigEditor({
  value,
  onChange,
}: {
  value: HookConfig | null;
  onChange: (next: HookConfig | null) => void;
}) {
  const rules = value?.pr ?? [];
  const comments = value?.comments ?? false;
  const prPreset = activePrPreset(rules);
  const commentPreset = activeCommentPreset(comments);

  function emit(next: HookConfig): void {
    const commentsActive =
      next.comments === true || (typeof next.comments === "object" && next.comments !== null);
    if (next.pr.length === 0 && !commentsActive) {
      onChange(null);
      return;
    }
    onChange(next);
  }

  function updateRule(idx: number, next: PrRule) {
    emit({
      ...value,
      pr: rules.map((r, i) => (i === idx ? next : r)),
      ...(comments === false ? {} : { comments }),
    });
  }

  function addRule() {
    emit({
      ...value,
      pr: [...rules, defaultPrRule()],
      ...(comments === false ? {} : { comments }),
    });
  }

  function removeRule(idx: number) {
    emit({
      ...value,
      pr: rules.filter((_, i) => i !== idx),
      ...(comments === false ? {} : { comments }),
    });
  }

  function pickPrPreset(d: DraftPreset) {
    // Replace the rule list with the single permissive rule. If the user
    // had bespoke rules they're surfaced in the cards below; preset
    // toggles a one-shot replace, not a stacked rule.
    emit({
      pr: [prCommitsPreset(d)],
      ...(comments === false ? {} : { comments }),
    });
  }

  function pickCommentPreset(c: CommenterPreset) {
    emit({ pr: rules, comments: commentsPreset(c) });
  }

  function clearCommentPreset() {
    emit({ pr: rules });
  }

  return (
    <div className="space-y-3">
      {/* Quick presets — the common cases the user-facing docs talk about. */}
      <div className="rounded-box border border-base-300 p-3 space-y-2">
        <div className="text-sm font-medium">Quick presets</div>
        <PresetRow
          label="On all PR commits"
          options={[
            { id: "open", label: "open" },
            { id: "draft", label: "draft" },
            { id: "any", label: "any" },
          ]}
          active={prPreset}
          onPick={(id) => pickPrPreset(id as DraftPreset)}
        />
        <PresetRow
          label="All comments left on PRs"
          options={[
            { id: "human", label: "human" },
            { id: "bot", label: "bot" },
            { id: "any", label: "any" },
          ]}
          active={commentPreset}
          onPick={(id) => pickCommentPreset(id as CommenterPreset)}
          onClear={commentPreset === null ? undefined : clearCommentPreset}
        />
      </div>

      {rules.length === 0 ? (
        <button type="button" className="btn btn-sm btn-outline" onClick={addRule}>
          <Plus size={14} /> Add PR trigger
        </button>
      ) : (
        <>
          {rules.map((rule, i) => (
            <RuleCard
              // biome-ignore lint/suspicious/noArrayIndexKey: rules are an ordered list with no stable id; index is fine for editor sessions.
              key={i}
              rule={rule}
              index={i}
              onChange={(next) => updateRule(i, next)}
              onRemove={() => removeRule(i)}
            />
          ))}
          <button type="button" className="btn btn-sm btn-outline" onClick={addRule}>
            <Plus size={14} /> Add rule
          </button>
        </>
      )}
    </div>
  );
}

function PresetRow({
  label,
  options,
  active,
  onPick,
  onClear,
}: {
  label: string;
  options: { id: string; label: string }[];
  active: string | null;
  onPick: (id: string) => void;
  onClear?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-base-content/70 mr-1">{label}:</span>
      <div role="radiogroup" className="join">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            aria-pressed={active === opt.id}
            onClick={() => onPick(opt.id)}
            className={`btn btn-xs join-item ${active === opt.id ? "btn-primary" : "btn-ghost border-base-300"}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="btn btn-ghost btn-xs"
          aria-label="Clear preset"
          title="Turn off"
        >
          ×
        </button>
      )}
    </div>
  );
}
