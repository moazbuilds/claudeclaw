import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";
import { parseWatchdogConfig, type WatchdogConfig } from "./watchdog";
import { parsePlugins, type PluginEntry } from "./plugins";

/** Re-exported under the name used in the Settings interface. */
export type WatchdogSettings = WatchdogConfig;

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
const DEFAULT_JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

/** Default Claude session timeout (30 minutes). Exported so runner.ts can reference the same value. */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function getJobsDir(): string {
  if (cached?.jobsDir) {
    return isAbsolute(cached.jobsDir) ? cached.jobsDir : join(process.cwd(), cached.jobsDir);
  }
  return DEFAULT_JOBS_DIR;
}

/** Returns the root directory for agent-scoped sessions and jobs. */
export function getAgentsDir(): string {
  return join(process.cwd(), "agents");
}

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  agentic: {
    enabled: false,
    defaultMode: "implementation",
    modes: [
      {
        name: "planning",
        model: "opus",
        keywords: [
          "plan", "design", "architect", "strategy", "approach",
          "research", "investigate", "analyze", "explore", "understand",
          "think", "consider", "evaluate", "assess", "review",
          "system design", "trade-off", "decision", "choose", "compare",
          "brainstorm", "ideate", "concept", "proposal",
        ],
        phrases: [
          "how to implement", "how should i", "what's the best way to",
          "should i", "which approach", "help me decide", "help me understand",
        ],
      },
      {
        name: "implementation",
        model: "sonnet",
        keywords: [
          "implement", "code", "write", "create", "build", "add",
          "fix", "debug", "refactor", "update", "modify", "change",
          "deploy", "run", "execute", "install", "configure",
          "test", "commit", "push", "merge", "release",
          "generate", "scaffold", "setup", "initialize",
        ],
      },
    ],
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: true,
  },
  telegram: { token: "", allowedUserIds: [], listenChats: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [], listenGuilds: [] },
  slack: { botToken: "", appToken: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  stt: { baseUrl: "", model: "" },
  sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  timeouts: { telegram: 5, heartbeat: 15, job: 30, default: 5 },
  watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
  session: { autoRotate: false, maxMessages: 50, maxAgeHours: 24, summaryPath: "" },
  plugins: {},
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
  forwardToTelegram: boolean;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  listenChats: number[];
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[]; // Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
  listenGuilds: string[]; // Guild IDs where bot responds to all messages in any channel/thread
}

export interface SlackConfig {
  botToken: string;       // xoxb-... bot token
  appToken: string;       // xapp-... Socket Mode token
  allowedUserIds: string[];
  listenChannels: string[]; // Channel IDs where bot responds without @mention
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface TimeoutsConfig {
  /** Max minutes for a telegram message subprocess. Default: 5 min. */
  telegram: number;
  /** Max minutes for a heartbeat subprocess. Default: 15 min. */
  heartbeat: number;
  /** Max minutes for a scheduled job subprocess. Default: 30 min. */
  job: number;
  /** Max minutes for all other subprocesses (bootstrap, trigger, etc). Default: 5 min. */
  default: number;
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  agentic: AgenticConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  security: SecurityConfig;
  web: WebConfig;
  stt: SttConfig;
  sessionTimeoutMs: number;
  timeouts: TimeoutsConfig;
  watchdog: WatchdogSettings;
  plugins: Record<string, PluginEntry>;
  session: SessionConfig;
  jobsDir?: string;
}


export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface SttConfig {
  /** Base URL of an OpenAI-compatible STT API, e.g. "http://127.0.0.1:8000".
   *  When set, claudeclaw routes voice transcription through this API instead
   *  of the bundled whisper.cpp binary. */
  baseUrl: string;
  /** Model name passed to the API (default: "Systran/faster-whisper-large-v3") */
  model: string;
}

export interface SessionConfig {
  /** Automatically rotate the global session when a threshold is exceeded. Default: false. */
  autoRotate: boolean;
  /** Rotate after this many messages. Default: 50. */
  maxMessages: number;
  /** Rotate after this many hours. Default: 24. */
  maxAgeHours: number;
  /** Directory to write markdown summaries before rotation. Empty string disables summaries. */
  summaryPath: string;
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(getJobsDir(), { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

function parseAgenticMode(raw: any): AgenticMode | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!name || !model) return null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k: unknown) => typeof k === "string").map((k: string) => k.toLowerCase().trim())
    : [];
  const phrases = Array.isArray(raw.phrases)
    ? raw.phrases.filter((p: unknown) => typeof p === "string").map((p: string) => p.toLowerCase().trim())
    : undefined;
  return { name, model, keywords, ...(phrases && phrases.length > 0 ? { phrases } : {}) };
}

function parseAgenticConfig(raw: any): AgenticConfig {
  const defaults = DEFAULT_SETTINGS.agentic;
  if (!raw || typeof raw !== "object") return defaults;

  const enabled = raw.enabled ?? false;

  // Backward compat: old planningModel/implementationModel format
  if (!Array.isArray(raw.modes) && ("planningModel" in raw || "implementationModel" in raw)) {
    const planningModel = typeof raw.planningModel === "string" ? raw.planningModel.trim() : "opus";
    const implModel = typeof raw.implementationModel === "string" ? raw.implementationModel.trim() : "sonnet";
    return {
      enabled,
      defaultMode: "implementation",
      modes: [
        { ...defaults.modes[0], model: planningModel },
        { ...defaults.modes[1], model: implModel },
      ],
    };
  }

  // New modes format
  const modes: AgenticMode[] = [];
  if (Array.isArray(raw.modes)) {
    for (const m of raw.modes) {
      const parsed = parseAgenticMode(m);
      if (parsed) modes.push(parsed);
    }
  }

  return {
    enabled,
    defaultMode: typeof raw.defaultMode === "string" ? raw.defaultMode.trim() : "implementation",
    modes: modes.length > 0 ? modes : defaults.modes,
  };
}

function parseSettings(
  raw: Record<string, any>,
  discordUserIds?: string[],
): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    agentic: parseAgenticConfig(raw.agentic),
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: raw.heartbeat?.enabled ?? false,
      interval: raw.heartbeat?.interval ?? 15,
      prompt: raw.heartbeat?.prompt ?? "",
      excludeWindows: parseExcludeWindows(raw.heartbeat?.excludeWindows),
      forwardToTelegram: raw.heartbeat?.forwardToTelegram ?? false,
    },
    telegram: {
      token: process.env.TELEGRAM_TOKEN?.trim() || (typeof raw.telegram?.token === "string" ? raw.telegram.token.trim() : ""),
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
      listenChats: Array.isArray(raw.telegram?.listenChats) ? raw.telegram.listenChats.map(Number) : [],
    },
    discord: {
      token: process.env.DISCORD_TOKEN?.trim() || (typeof raw.discord?.token === "string" ? raw.discord.token.trim() : ""),
      allowedUserIds: Array.isArray(discordUserIds) && discordUserIds.length > 0
        ? discordUserIds
        : Array.isArray(raw.discord?.allowedUserIds)
          ? raw.discord.allowedUserIds.map(String)
          : [],
      listenChannels: Array.isArray(raw.discord?.listenChannels)
        ? raw.discord.listenChannels.map(String)
        : [],
      listenGuilds: Array.isArray(raw.discord?.listenGuilds)
        ? raw.discord.listenGuilds.map(String)
        : [],
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN?.trim() || (typeof raw.slack?.botToken === "string" ? raw.slack.botToken.trim() : ""),
      appToken: process.env.SLACK_APP_TOKEN?.trim() || (typeof raw.slack?.appToken === "string" ? raw.slack.appToken.trim() : ""),
      allowedUserIds: Array.isArray(raw.slack?.allowedUserIds) ? raw.slack.allowedUserIds.map(String) : [],
      listenChannels: Array.isArray(raw.slack?.listenChannels) ? raw.slack.listenChannels.map(String) : [],
    },
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools)
        ? raw.security.allowedTools
        : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: Number.isFinite(raw.web?.port) ? Number(raw.web.port) : 4632,
    },
    stt: {
      baseUrl: typeof raw.stt?.baseUrl === "string" ? raw.stt.baseUrl.trim() : "",
      model: typeof raw.stt?.model === "string" ? raw.stt.model.trim() : "",
    },
    sessionTimeoutMs: typeof raw.sessionTimeoutMs === "number" && raw.sessionTimeoutMs > 0
      ? raw.sessionTimeoutMs
      : DEFAULT_SESSION_TIMEOUT_MS,
    timeouts: {
      telegram: Number.isFinite(raw.timeouts?.telegram) ? Number(raw.timeouts.telegram) : 5,
      heartbeat: Number.isFinite(raw.timeouts?.heartbeat) ? Number(raw.timeouts.heartbeat) : 15,
      job: Number.isFinite(raw.timeouts?.job) ? Number(raw.timeouts.job) : 30,
      default: Number.isFinite(raw.timeouts?.default) ? Number(raw.timeouts.default) : 5,
    },
    watchdog: parseWatchdogConfig(raw.watchdog),
    plugins: parsePlugins(raw.plugins),
    session: {
      autoRotate: raw.session?.autoRotate ?? false,
      maxMessages: Number.isFinite(raw.session?.maxMessages) ? Number(raw.session.maxMessages) : 50,
      maxAgeHours: Number.isFinite(raw.session?.maxAgeHours) ? Number(raw.session.maxAgeHours) : 24,
      summaryPath: typeof raw.session?.summaryPath === "string" ? raw.session.summaryPath.trim() : "",
    },
    ...(typeof raw.jobsDir === "string" && raw.jobsDir.trim() ? { jobsDir: raw.jobsDir.trim() } : {}),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const start = typeof (entry as any).start === "string" ? (entry as any).start.trim() : "";
    const end = typeof (entry as any).end === "string" ? (entry as any).end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray((entry as any).days) ? (entry as any).days : [];
    const parsedDays = rawDays
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort((a: number, b: number) => a - b);

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Extract discord.allowedUserIds as raw strings from the JSON text.
 * JSON.parse destroys precision on large numeric snowflakes (>2^53),
 * so we regex them out of the raw text first.
 */
function extractDiscordUserIds(rawText: string): string[] {
  // Match the "discord" object's "allowedUserIds" array values
  const discordBlock = rawText.match(/"discord"\s*:\s*\{[\s\S]*?\}/);
  if (!discordBlock) return [];
  const arrayMatch = discordBlock[0].match(/"allowedUserIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const items: string[] = [];
  // Match both quoted strings and bare numbers
  for (const m of arrayMatch[1].matchAll(/("(\d+)"|(\d+))/g)) {
    items.push(m[2] ?? m[3]);
  }
  return items;
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

/**
 * If the prompt string looks like a file path (ends with .md, .txt, or .prompt),
 * read and return the file contents. Otherwise return the string as-is.
 * Relative paths are resolved from the project root (cwd).
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
