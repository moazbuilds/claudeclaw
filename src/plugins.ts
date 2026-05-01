/**
 * ClaudeClaw Daemon Plugin System
 *
 * Provides an OpenClaw-compatible Plugin API for daemon-level plugins.
 * Plugins hook into lifecycle events that fire AROUND Claude Code invocations
 * (not inside them — that's handled by Claude Code's native plugin system).
 *
 * Usage in settings.json:
 *   "plugins": {
 *     "claude-mem": {
 *       "enabled": true,
 *       "source": "openclaw",
 *       "config": { "workerPort": 37777, "project": "myproject" }
 *     }
 *   }
 */

import { join } from "path";
import { existsSync } from "fs";

// ── Event types ──────────────────────────────────────────────────────────────

export type DaemonEvent =
  | "gateway_start"
  | "session_start"
  | "before_agent_start"
  | "before_prompt_build"
  | "tool_result_persist"
  | "agent_end"
  | "after_compaction";

export interface EventContext {
  sessionKey?: string;
  conversationId?: string;
  channelId?: string;
  agentId?: string;
  workspaceDir?: string;
}

export type EventHandler = (data: any, ctx: EventContext) => Promise<any> | any;

// ── Plugin API types ─────────────────────────────────────────────────────────

export interface PluginService {
  id: string;
  start: (ctx: any) => Promise<void>;
  stop: (ctx: any) => Promise<void>;
}

export interface PluginCommand {
  name: string;
  description?: string;
  acceptsArgs?: boolean;
  handler: (ctx: any) => Promise<any>;
}

export interface PluginApi {
  on(event: string, handler: EventHandler): void;
  registerService(service: PluginService): void;
  registerCommand(cmd: PluginCommand): void;
  runtime: {
    channel: Record<string, Record<string, Function>>;
  };
  logger: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
  pluginConfig: Record<string, any>;
}

export type PluginInitFn = (api: PluginApi) => void | Promise<void>;

// ── Settings types ───────────────────────────────────────────────────────────

export interface PluginEntry {
  enabled: boolean;
  /** "openclaw" | npm package name | absolute path to plugin dir */
  source: string;
  config: Record<string, any>;
}

// ── Plugin Manager ───────────────────────────────────────────────────────────

export class PluginManager {
  private handlers = new Map<string, EventHandler[]>();
  private services = new Map<string, PluginService>();
  private commands = new Map<string, PluginCommand>();
  private channelRuntime: Record<string, Record<string, Function>> = {};
  private workspaceDir: string;
  private loadedPlugins: string[] = [];

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  // ── Loading ────────────────────────────────────────────────────────────

  async loadAll(plugins: Record<string, PluginEntry>): Promise<void> {
    for (const [id, entry] of Object.entries(plugins)) {
      if (!entry.enabled) continue;
      try {
        await this.loadPlugin(id, entry);
      } catch (err) {
        console.error(`[${ts()}] [plugins] Failed to load "${id}":`, err);
      }
    }
  }

  async unloadAll(): Promise<void> {
    await this.stopServices();
    this.handlers.clear();
    this.services.clear();
    this.commands.clear();
    this.loadedPlugins = [];
  }

  private async loadPlugin(id: string, entry: PluginEntry): Promise<void> {
    const source = entry.source || "openclaw";

    if (source === "openclaw" && entry.config?.workerPort) {
      const host = entry.config.workerHost || "127.0.0.1";
      const port = entry.config.workerPort;
      const healthy = await this.checkHealth(host, port);
      if (!healthy) {
        console.warn(`[${ts()}] [plugins] ${id}: worker not running on ${host}:${port}, skipping`);
        return;
      }
    }

    const modulePath = this.resolvePluginPath(id, source);
    if (!modulePath) {
      console.warn(`[${ts()}] [plugins] ${id}: could not resolve module (source: ${source})`);
      return;
    }

    const api = this.buildApi(id, entry.config || {});

    const mod = await import(modulePath);
    const initFn: PluginInitFn = mod.default || mod;
    if (typeof initFn !== "function") {
      console.warn(`[${ts()}] [plugins] ${id}: module does not export a function`);
      return;
    }

    await initFn(api);
    this.loadedPlugins.push(id);
    console.log(`[${ts()}] [plugins] ${id}: loaded (source: ${source})`);
  }

  private resolvePluginPath(id: string, source: string): string | null {
    const candidates: string[] = [];

    if (source.startsWith("/")) {
      candidates.push(
        join(source, "openclaw", "dist", "index.js"),
        join(source, "dist", "index.js"),
        join(source, "index.js"),
      );
    } else if (source === "openclaw") {
      candidates.push(
        join(this.workspaceDir, ".claude", "claudeclaw", id, "openclaw", "dist", "index.js"),
        join(this.workspaceDir, "node_modules", id, "openclaw", "dist", "index.js"),
        join(process.env.HOME || "", ".claude", "plugins", "marketplaces", "thedotmack", "openclaw", "dist", "index.js"),
        join(process.env.HOME || "", ".openclaw", "extensions", id, "dist", "index.js"),
      );
    } else {
      candidates.push(
        join(this.workspaceDir, "node_modules", source, "dist", "index.js"),
        join(this.workspaceDir, "node_modules", source, "index.js"),
      );
    }

    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  private async checkHealth(host: string, port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private buildApi(pluginId: string, config: Record<string, any>): PluginApi {
    const self = this;
    return {
      on(event: string, handler: EventHandler) {
        const list = self.handlers.get(event) || [];
        list.push(handler);
        self.handlers.set(event, list);
      },
      registerService(service: PluginService) {
        self.services.set(service.id, service);
      },
      registerCommand(cmd: PluginCommand) {
        self.commands.set(cmd.name, cmd);
      },
      runtime: {
        channel: self.channelRuntime,
      },
      logger: {
        info: (...args: any[]) => console.log(`[${ts()}] [${pluginId}]`, ...args),
        warn: (...args: any[]) => console.warn(`[${ts()}] [${pluginId}]`, ...args),
        error: (...args: any[]) => console.error(`[${ts()}] [${pluginId}]`, ...args),
        debug: () => {},
      },
      pluginConfig: config,
    };
  }

  // ── Services ───────────────────────────────────────────────────────────

  async startServices(): Promise<void> {
    for (const [id, service] of this.services) {
      try {
        await service.start({});
      } catch (err) {
        console.warn(`[${ts()}] [plugins] Service ${id} failed to start:`, err);
      }
    }
  }

  async stopServices(): Promise<void> {
    for (const [id, service] of this.services) {
      try {
        await service.stop({});
      } catch {}
    }
  }

  // ── Channel runtime ────────────────────────────────────────────────────

  setChannelSenders(senders: Record<string, Record<string, Function>>): void {
    Object.assign(this.channelRuntime, senders);
  }

  // ── Event emission ─────────────────────────────────────────────────────

  /**
   * Emit an event to all registered handlers.
   * For `before_prompt_build`, collects all `appendSystemContext` strings
   * and returns them concatenated. For other events, returns the last result.
   */
  async emit(event: DaemonEvent, data: any, ctx: EventContext): Promise<any> {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.length === 0) return undefined;

    if (event === "before_prompt_build") {
      const contexts: string[] = [];
      for (const handler of handlers) {
        try {
          const result = await handler(data, ctx);
          if (result?.appendSystemContext) {
            contexts.push(result.appendSystemContext);
          }
        } catch (err) {
          console.warn(`[${ts()}] [plugins] Event ${event} handler error:`, err);
        }
      }
      return contexts.length > 0
        ? { appendSystemContext: contexts.join("\n\n") }
        : undefined;
    }

    let result: any;
    for (const handler of handlers) {
      try {
        result = await handler(data, ctx);
      } catch (err) {
        console.warn(`[${ts()}] [plugins] Event ${event} handler error:`, err);
      }
    }
    return result;
  }

  /**
   * Fire-and-forget emit — does not await handlers.
   * Use for observations where we don't need the result.
   */
  emitAsync(event: DaemonEvent, data: any, ctx: EventContext): void {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.length === 0) return;
    for (const handler of handlers) {
      try {
        Promise.resolve(handler(data, ctx)).catch((err) => {
          console.warn(`[${ts()}] [plugins] Async event ${event} error:`, err);
        });
      } catch {}
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────

  async runCommand(name: string, args?: string): Promise<string | null> {
    const cmd = this.commands.get(name);
    if (!cmd) return null;
    try {
      const result = await cmd.handler({ args });
      return typeof result === "string" ? result : result?.text ?? JSON.stringify(result);
    } catch (err) {
      console.warn(`[${ts()}] [plugins] Command "${name}" error:`, err);
      return null;
    }
  }

  getCommandNames(): string[] {
    return Array.from(this.commands.keys());
  }

  // ── Info ────────────────────────────────────────────────────────────────

  get loaded(): string[] {
    return this.loadedPlugins;
  }

  get hasPlugins(): boolean {
    return this.loadedPlugins.length > 0;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let manager: PluginManager | null = null;

export function getPluginManager(): PluginManager | null {
  return manager;
}

export function setPluginManager(m: PluginManager | null): void {
  manager = m;
}

// ── Config parser ────────────────────────────────────────────────────────────

export function parsePlugins(raw: any): Record<string, PluginEntry> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, PluginEntry> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, any>;
    result[id] = {
      enabled: e.enabled ?? false,
      source: typeof e.source === "string" ? e.source.trim() : "openclaw",
      config: e.config && typeof e.config === "object" ? e.config : {},
    };
  }
  return result;
}

function ts() {
  return new Date().toLocaleTimeString();
}
