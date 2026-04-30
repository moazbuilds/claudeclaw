import { runPluginCli, readPluginManifest, type PluginManifest } from "./plugin-cli";
import { ensureAgentDir } from "../runner";

const WIZARD_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Commands that trigger the wizard (and their alias).
const TRIGGER_COMMANDS = new Set(["/plugin", "/claudeclaw:plugin"]);

export interface WizardContext {
  iface: "discord" | "telegram" | "web";
  scopeId: string;
  agentName?: string; // recorded for Phase 2 per-agent scoping
}

type WizardStep =
  | { step: "choose-action" }
  | { step: "marketplace-source" }
  | { step: "marketplace-name-to-update" }
  | { step: "marketplace-name-to-remove" }
  | { step: "install-plugin-ref" }
  | { step: "install-scope"; plugin: string }
  | { step: "install-confirm"; plugin: string; scope: "user" | "project"; manifest: PluginManifest | null }
  | { step: "uninstall-plugin" }
  | { step: "enable-plugin" }
  | { step: "disable-plugin" };

interface WizardEntry {
  state: WizardStep;
  ctx: WizardContext;
  expiry: number;
}

const sessions = new Map<string, WizardEntry>();

// Sweep expired entries every 15 minutes so the Map doesn't grow unbounded
// in a long-running daemon. unref() prevents this timer from keeping the
// process alive if it would otherwise exit.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of sessions) {
    if (now > entry.expiry) sessions.delete(k);
  }
}, 15 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

function key(ctx: WizardContext): string {
  return `${ctx.iface}:${ctx.scopeId}`;
}

function fresh(ctx: WizardContext, state: WizardStep): WizardEntry {
  return { state, ctx, expiry: Date.now() + WIZARD_TTL_MS };
}

function isExpired(entry: WizardEntry): boolean {
  return Date.now() > entry.expiry;
}

export function isWizardTrigger(text: string): boolean {
  const first = text.trim().split(/\s+/, 1)[0].toLowerCase();
  return TRIGGER_COMMANDS.has(first);
}

export function hasActiveWizard(ctx: WizardContext): boolean {
  const entry = sessions.get(key(ctx));
  if (!entry) return false;
  if (isExpired(entry)) {
    sessions.delete(key(ctx));
    return false;
  }
  return true;
}

export function cancelWizard(ctx: WizardContext): void {
  sessions.delete(key(ctx));
}

const MENU = `Plugin marketplace — what would you like to do?

1) Add marketplace
2) Update marketplace
3) Remove marketplace
4) Install plugin
5) Uninstall plugin
6) Enable plugin
7) Disable plugin
8) List installed plugins
9) List marketplaces

Reply with a number. Send 'cancel' at any time to exit and return to normal chat.
(While this wizard is open all messages are routed here, not to Claude.)`;

function buildScopePrompt(agentName?: string): string {
  // agentName is already a normalised key (from agentDirKey) — display it directly.
  const projectNote = agentName
    ? `2) project — agents/${agentName}/.claude/plugins/ (this agent only)`
    : "2) project — .claude/plugins/ (this deployment only)";
  return `Install scope (reply 'cancel' to exit):\n\n1) user — ~/.claude/plugins/ (available to all agents)\n${projectNote}\n`;
}

function formatManifest(plugin: string, manifest: PluginManifest | null, scope: "user" | "project"): string {
  const scopeLabel = scope === "user" ? "user (~/.claude/plugins/)" : "project (.claude/plugins/)";
  if (!manifest) {
    return `Install plugin \`${plugin}\` into scope: ${scopeLabel}?\n\nReply 'yes' to confirm or 'cancel' to exit.`;
  }
  const lines = [
    `Install \`${manifest.name}\` v${manifest.version} into scope: ${scopeLabel}?`,
    "",
    manifest.description ?? "",
  ];
  if (manifest.tools?.length) lines.push(`Tools: ${manifest.tools.join(", ")}`);
  if (manifest.permissions?.length) lines.push(`Permissions: ${manifest.permissions.join(", ")}`);
  lines.push("", "Reply 'yes' to confirm or 'cancel' to exit.");
  return lines.filter((l, i) => !(i > 0 && l === "" && lines[i - 1] === "")).join("\n");
}

function formatResult(ok: boolean, stdout: string, stderr: string): string {
  if (ok) {
    return stdout || "Done.";
  }
  const detail = stderr || stdout || "Unknown error.";
  return `Error: ${detail}`;
}

export async function handleWizardInput(ctx: WizardContext, rawText: string): Promise<string> {
  const k = key(ctx);
  const text = rawText.trim();
  const lower = text.toLowerCase();

  if (lower === "cancel") {
    sessions.delete(k);
    return "Plugin wizard cancelled.";
  }

  let entry = sessions.get(k);
  if (!entry || isExpired(entry)) {
    // New wizard session — must be a trigger command
    if (!isWizardTrigger(text)) return "Send /plugin to open the plugin wizard.";
    entry = fresh(ctx, { step: "choose-action" });
    sessions.set(k, entry);
    return MENU;
  }

  // Refresh TTL on each interaction
  entry.expiry = Date.now() + WIZARD_TTL_MS;

  const { state } = entry;

  switch (state.step) {
    case "choose-action": {
      switch (text) {
        case "1": entry.state = { step: "marketplace-source" }; return "Send the marketplace URL, local path, or GitHub repo (e.g. `owner/repo`):";
        case "2": entry.state = { step: "marketplace-name-to-update" }; return "Send marketplace name to update (leave blank / send 'all' to update all):";
        case "3": entry.state = { step: "marketplace-name-to-remove" }; return "Send the marketplace name to remove:";
        case "4": entry.state = { step: "install-plugin-ref" }; return "Send plugin name (e.g. `my-plugin` or `my-plugin@marketplace-name`):";
        case "5": entry.state = { step: "uninstall-plugin" }; return "Send the plugin name to uninstall:";
        case "6": entry.state = { step: "enable-plugin" }; return "Send the plugin name to enable:";
        case "7": entry.state = { step: "disable-plugin" }; return "Send the plugin name to disable:";
        case "8": {
          sessions.delete(k);
          const r = await runPluginCli({ kind: "list" });
          return formatResult(r.ok, r.stdout, r.stderr);
        }
        case "9": {
          sessions.delete(k);
          const r = await runPluginCli({ kind: "marketplace-list" });
          return formatResult(r.ok, r.stdout, r.stderr);
        }
        default:
          return `'${text}' is not a valid option. Send 'cancel' to exit the wizard and return to normal chat.\n\n${MENU}`;
      }
    }

    case "marketplace-source": {
      sessions.delete(k);
      const r = await runPluginCli({ kind: "marketplace-add", source: text });
      return formatResult(r.ok, r.stdout, r.stderr);
    }

    case "marketplace-name-to-update": {
      sessions.delete(k);
      const name = lower === "all" || text === "" ? undefined : text;
      const r = await runPluginCli({ kind: "marketplace-update", name });
      return formatResult(r.ok, r.stdout, r.stderr);
    }

    case "marketplace-name-to-remove": {
      sessions.delete(k);
      const r = await runPluginCli({ kind: "marketplace-remove", name: text });
      return formatResult(r.ok, r.stdout, r.stderr);
    }

    case "install-plugin-ref": {
      entry.state = { step: "install-scope", plugin: text };
      return buildScopePrompt(ctx.agentName);
    }

    case "install-scope": {
      const scope = text === "1" ? "user" : text === "2" ? "project" : null;
      if (!scope) return `Reply '1' for user or '2' for project scope:\n\n${buildScopePrompt(ctx.agentName)}`;
      const manifest = await readPluginManifest(state.plugin);
      entry.state = { step: "install-confirm", plugin: state.plugin, scope, manifest };
      return formatManifest(state.plugin, manifest, scope);
    }

    case "install-confirm": {
      if (lower !== "yes") return `Reply 'yes' to install or 'cancel' to exit.`;
      sessions.delete(k);
      const cwd = state.scope === "project" && ctx.agentName
        ? await ensureAgentDir(ctx.agentName)
        : undefined;
      const r = await runPluginCli({ kind: "install", plugin: state.plugin, scope: state.scope }, cwd);
      const msg = formatResult(r.ok, r.stdout, r.stderr);
      if (r.ok) {
        const location = state.scope === "project" && ctx.agentName
          ? `agents/${ctx.agentName}/.claude/plugins/`
          : "~/.claude/plugins/";
        return `${msg}\n\nInstalled to ${location}. Skills it provides will be available as /<plugin>:<skill-name> commands.`;
      }
      return msg;
    }

    case "uninstall-plugin": {
      sessions.delete(k);
      const r = await runPluginCli({ kind: "uninstall", plugin: text });
      return formatResult(r.ok, r.stdout, r.stderr);
    }

    case "enable-plugin": {
      sessions.delete(k);
      const r = await runPluginCli({ kind: "enable", plugin: text });
      return formatResult(r.ok, r.stdout, r.stderr);
    }

    case "disable-plugin": {
      sessions.delete(k);
      const r = await runPluginCli({ kind: "disable", plugin: text });
      return formatResult(r.ok, r.stdout, r.stderr);
    }
  }
}
