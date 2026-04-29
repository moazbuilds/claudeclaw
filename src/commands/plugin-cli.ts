import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";

const SPAWN_TIMEOUT_MS = 30_000;

export type PluginAction =
  | { kind: "marketplace-add"; source: string }
  | { kind: "marketplace-list" }
  | { kind: "marketplace-update"; name?: string }
  | { kind: "marketplace-remove"; name: string }
  | { kind: "install"; plugin: string; scope: "user" | "project" }
  | { kind: "list" }
  | { kind: "uninstall"; plugin: string }
  | { kind: "enable"; plugin: string }
  | { kind: "disable"; plugin: string };

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  tools?: string[];
  permissions?: string[];
}

function buildArgs(action: PluginAction): string[] {
  switch (action.kind) {
    case "marketplace-add":
      return ["claude", "plugin", "marketplace", "add", action.source];
    case "marketplace-list":
      return ["claude", "plugin", "marketplace", "list"];
    case "marketplace-update":
      return action.name
        ? ["claude", "plugin", "marketplace", "update", action.name]
        : ["claude", "plugin", "marketplace", "update"];
    case "marketplace-remove":
      return ["claude", "plugin", "marketplace", "remove", action.name];
    case "install":
      return ["claude", "plugin", "install", action.plugin, "-s", action.scope];
    case "list":
      return ["claude", "plugin", "list"];
    case "uninstall":
      return ["claude", "plugin", "uninstall", action.plugin];
    case "enable":
      return ["claude", "plugin", "enable", action.plugin];
    case "disable":
      return ["claude", "plugin", "disable", action.plugin];
  }
}

export async function runPluginCli(action: PluginAction, cwd?: string): Promise<CliResult> {
  const args = buildArgs(action);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill();
  }, SPAWN_TIMEOUT_MS);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      ok: !killed && exitCode === 0,
      stdout: stdout.trim(),
      stderr: killed ? "Command timed out after 30s" : stderr.trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Reads plugin.json from the first matching installed marketplace directory.
// Returns null if not found — wizard will skip the manifest confirmation step.
export async function readPluginManifest(pluginRef: string): Promise<PluginManifest | null> {
  const [pluginName, marketplace] = pluginRef.includes("@")
    ? (pluginRef.split("@", 2) as [string, string])
    : [pluginRef, undefined];

  const pluginsRoot = join(homedir(), ".claude", "plugins");
  let marketplaces: string[];
  try {
    marketplaces = marketplace ? [marketplace] : await readdir(pluginsRoot);
  } catch {
    return null;
  }

  for (const mp of marketplaces) {
    const manifestPath = join(pluginsRoot, mp, "plugins", pluginName, "plugin.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      const json = JSON.parse(raw) as Partial<PluginManifest>;
      return {
        name: json.name ?? pluginName,
        version: json.version ?? "unknown",
        description: json.description,
        tools: json.tools,
        permissions: json.permissions,
      };
    } catch {
      // try next marketplace
    }
  }

  return null;
}

// Exported for testability — returns the argv array for a given action.
export { buildArgs };
