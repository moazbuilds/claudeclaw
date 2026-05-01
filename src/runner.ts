import { mkdir, readFile, writeFile, realpath } from "fs/promises";
import { join, resolve, sep } from "path";
import { existsSync } from "fs";
import {
  getSession,
  createSession,
  incrementTurn,
  markCompactWarned,
  getFallbackSession,
  createFallbackSession,
  incrementFallbackTurn,
} from "./sessions";
import {
  getThreadSession,
  createThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
} from "./sessionManager";
import { getSettings, DEFAULT_SESSION_TIMEOUT_MS, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { selectModel } from "./model-router";
import { recordResult, abortReason, clearSession, startSession } from "./watchdog";
import { getPluginManager, type EventContext } from "./plugins";

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");
// Resolve prompts relative to the claudeclaw installation, not the project dir
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");
// Project-level prompt overrides live here (gitignored, user-owned)
const PROJECT_PROMPTS_DIR = join(process.cwd(), ".claude", "claudeclaw", "prompts");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const CLAUDECLAW_BLOCK_START = "<!-- claudeclaw:managed:start -->";
const CLAUDECLAW_BLOCK_END = "<!-- claudeclaw:managed:end -->";

/**
 * Compact configuration.
 * COMPACT_WARN_THRESHOLD: notify user that context is getting large.
 * COMPACT_TIMEOUT_ENABLED: whether to auto-compact on timeout (exit 124).
 */
const COMPACT_WARN_THRESHOLD = 25;
const COMPACT_TIMEOUT_ENABLED = true;

/**
 * Build a sanitized env for spawning the `claude` CLI as a long-running daemon
 * subprocess. Drops env vars injected by a parent Claude Code / Claude Desktop
 * session that break detached child auth:
 *
 * - `CLAUDECODE`: marks "we're nested inside Claude Code" — confuses the CLI's
 *   reentry detection and triggers transcript-aware behaviour we don't want.
 * - `CLAUDE_CODE_OAUTH_TOKEN`: the parent's frozen OAuth access token. Without
 *   the matching refresh token (which lives in the platform-native credential
 *   store, not the env), it expires after ~8h and the daemon's spawned `claude`
 *   processes start returning HTTP 401 silently. Stripping it lets the CLI
 *   fall back to the credential store on each platform — Keychain on macOS,
 *   `~/.claude/.credentials.json` on Linux/WSL2, Credential Manager on Windows
 *   — which handles refresh automatically.
 * - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`: tells the CLI "the host process
 *   manages provider auth — don't read local credentials." In a detached
 *   daemon there is no host to consult; the CLI errors with `Not logged in`.
 *
 * Cross-platform note: the helper just deletes keys from the inherited env
 * object — no shell, no OS-specific calls. The `claude` CLI it spawns then
 * resolves credentials using its own per-platform code path.
 */
function cleanSpawnEnv(): Record<string, string> {
  const stripped = new Set([
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped.has(key)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export type CompactEvent =
  | { type: "warn"; turnCount: number }
  | { type: "auto-compact-start" }
  | { type: "auto-compact-done"; success: boolean }
  | { type: "auto-compact-retry"; success: boolean; stdout: string; stderr: string; exitCode: number };

type CompactEventListener = (event: CompactEvent) => void;
const compactListeners: CompactEventListener[] = [];

/** Register a listener for compact-related events (warnings, auto-compact notifications). */
export function onCompactEvent(listener: CompactEventListener): void {
  compactListeners.push(listener);
}

function emitCompactEvent(event: CompactEvent): void {
  for (const listener of compactListeners) {
    try { listener(event); } catch {}
  }
}

function pluginCtx(threadId?: string, agentName?: string): EventContext {
  return {
    sessionKey: threadId || "global",
    conversationId: threadId || "global",
    channelId: threadId || "global",
    agentId: agentName,
    workspaceDir: process.cwd(),
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RATE_LIMIT_PATTERN = /you.ve hit your limit|out of extra usage/i;

// Serial queue — prevents concurrent --resume on the same session
// Global queue for non-thread messages (backward compatible)
// Reset to a fresh resolved promise after each task to avoid holding
// references to every previous result (memory leak).
let globalQueue: Promise<unknown> = Promise.resolve();
// Per-thread queues — each thread runs independently in parallel
const threadQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  if (threadId) {
    const current = threadQueues.get(threadId) ?? Promise.resolve();
    const task = current.then(fn, fn);
    threadQueues.set(threadId, task.then(() => {}, () => {}));
    return task;
  }
  const task = globalQueue.then(fn, fn);
  globalQueue = task.then(() => {}, () => {});
  return task;
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /enoent|no such file or directory/i.test(message);
}

function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

// Cap stdout/stderr to prevent unbounded memory growth.
// 10 MB is far beyond any real Claude response; protects against runaway streams only.
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function collectStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes < maxBytes) {
        const space = maxBytes - totalBytes;
        if (value.byteLength <= space) {
          chunks.push(value);
          totalBytes += value.byteLength;
        } else {
          chunks.push(value.subarray(0, space));
          totalBytes = maxBytes;
          // cap reached — keep draining without storing so the child process isn't blocked
        }
      }
      // beyond cap: read and discard to keep the pipe flowing
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}


async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
  cwd?: string
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
    ...(cwd ? { cwd } : {}),
  });

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  try {
    const [rawStdout, stderr] = await Promise.race([
      Promise.all([
        collectStream(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
        collectStream(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
      ]),
      timeoutPromise,
    ]) as [string, string];

    if (timeoutId) clearTimeout(timeoutId);
    await proc.exited;

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    // Kill the hung process
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);

    return {
      rawStdout: "",
      stderr: message,
      exitCode: 124,
    };
  }
}

// Runs claude with --output-format stream-json --verbose, reading NDJSON events as they
// arrive rather than buffering the full stdout. This allows the parent process to remain
// responsive while Claude orchestrates subagents via the Task tool — each subagent emits
// events through the parent's stdout stream, so the process stays alive and producing
// output until all agents finish. Returns the final result text and the session ID
// captured from the stream/init event.
async function runClaudeStream(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
  cwd?: string
): Promise<{ rawStdout: string; stderr: string; exitCode: number; sessionId?: string }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
    ...(cwd ? { cwd } : {}),
  });

  let sessionId: string | undefined;
  let resultText = "";
  let stderr = "";

  const readStdout = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          if ((event.type === "system" || event.type === "result") && typeof event.session_id === "string") {
            sessionId = event.session_id;
          }
          if (event.type === "result" && typeof event.result === "string") {
            resultText = event.result;
          }
        } catch {}
      }
    }
  };

  const readStderr = async () => {
    stderr = await collectStream(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES);
  };

  let streamJsonTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    streamJsonTimeoutId = setTimeout(() => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  try {
    await Promise.race([
      Promise.all([readStdout(), readStderr()]),
      timeoutPromise,
    ]);
    if (streamJsonTimeoutId) clearTimeout(streamJsonTimeoutId);
    await proc.exited;
    return { rawStdout: resultText, stderr: stderr.trim(), exitCode: proc.exitCode ?? 1, sessionId };
  } catch (err) {
    if (streamJsonTimeoutId) clearTimeout(streamJsonTimeoutId);
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);
    return { rawStdout: "", stderr: message, exitCode: 124, sessionId };
  }
}

const PROJECT_DIR = process.cwd();

// Converts a raw agent/thread display name to a safe filesystem segment.
// Converts a display name to a safe filesystem segment (no unique suffix).
// Exported for display-only use (e.g. showing the human-readable name in UI).
export function safeAgentSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error(`Agent name "${raw}" cannot be converted to a safe path segment`);
  return slug;
}

// Builds a guaranteed-unique, filesystem-safe directory key for an agent thread.
// Truncates the display slug to leave room for "-<threadId>" so the suffix is
// NEVER truncated away on a second slugging pass.
export function agentDirKey(rawName: string, threadId: string): string {
  const suffix = `-${threadId}`;
  const maxSlugLen = Math.max(1, 64 - suffix.length);
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxSlugLen);
  if (!slug) throw new Error(`Agent name "${rawName}" cannot be converted to a safe path segment`);
  return `${slug}${suffix}`;
}

// Returns the working directory for a named agent's Claude spawn.
// Works with any agent name — Discord-generated keys (from agentDirKey) or
// raw filesystem directory names used by scheduled jobs.
// Security: uses realpath() after mkdir so symlinks are resolved before the
// containment check. A lexical path.resolve() check is not sufficient because
// a symlinked agents/<name> can point outside the repo and pass lexical checks.
export async function ensureAgentDir(name: string): Promise<string> {
  const agentsRoot = join(PROJECT_DIR, "agents");
  const dir = join(agentsRoot, name);
  // Lexical pre-check: reject obvious traversal before touching the filesystem
  if (!resolve(dir).startsWith(resolve(agentsRoot) + sep)) {
    throw new Error(`Agent directory "${dir}" would escape the agents root — rejecting`);
  }
  await mkdir(dir, { recursive: true });
  // Post-mkdir realpath checks resolve symlinks at every level.
  // We verify two things:
  //   1. agents/ itself resolves inside PROJECT_DIR (catches a symlinked agents/ root)
  //   2. agents/<name> resolves inside agents/ (catches a symlinked individual agent dir)
  const realProjectDir = await realpath(PROJECT_DIR);
  const realRoot = await realpath(agentsRoot);
  const realDir = await realpath(dir);
  if (!realRoot.startsWith(realProjectDir + sep)) {
    throw new Error(`agents/ root "${realRoot}" resolves outside the project directory via symlink — rejecting`);
  }
  if (!realDir.startsWith(realRoot + sep)) {
    throw new Error(`Agent directory "${realDir}" resolves outside the agents root via symlink — rejecting`);
  }
  return realDir;
}

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

export async function ensureProjectClaudeMd(): Promise<void> {
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [
    CLAUDECLAW_BLOCK_START,
    promptContent,
    CLAUDECLAW_BLOCK_END,
  ].join("\n");

  let content = "";

  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(CLAUDECLAW_BLOCK_START) && normalized.includes(CLAUDECLAW_BLOCK_END);
  const managedPattern = new RegExp(
    `${CLAUDECLAW_BLOCK_START}[\\s\\S]*?${CLAUDECLAW_BLOCK_END}`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
      // all tools available, scoped to project dir via system prompt
      break;
    case "unrestricted":
      // all tools, no directory restriction
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

/** Load and concatenate all prompt files from the prompts/ directory. */
async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/claudeclaw/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(PROJECT_PROMPTS_DIR, "HEARTBEAT.md");
  for (const file of [projectOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(`[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`, e);
      }
    }
  }
  return "";
}

/** Run /compact on the current session to reduce context size. */
export async function runCompact(
  sessionId: string,
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  securityArgs: string[],
  timeoutMs: number,
  cwd?: string
): Promise<boolean> {
  const compactArgs = [
    "claude", "-p", "/compact",
    "--output-format", "text",
    "--resume", sessionId,
    ...securityArgs,
  ];
  console.log(`[${new Date().toLocaleTimeString()}] Running /compact on session ${sessionId.slice(0, 8)}...`);
  const result = await runClaudeOnce(compactArgs, model, api, baseEnv, timeoutMs, cwd);
  const success = result.exitCode === 0;
  console.log(`[${new Date().toLocaleTimeString()}] Compact ${success ? "succeeded" : `failed (exit ${result.exitCode})`}`);
  return success;
}

/**
 * High-level compact: resolves session + settings internally.
 * Returns { success, message }.
 */
export async function compactCurrentSession(agentName?: string): Promise<{ success: boolean; message: string }> {
  const existing = await getSession(agentName);
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const securityArgs = buildSecurityArgs(settings.security);
  const baseEnv = cleanSpawnEnv();
  const timeoutMs = settings.sessionTimeoutMs;

  const compactCwd = agentName ? await ensureAgentDir(agentName) : undefined;
  const ok = await runCompact(
    existing.sessionId,
    settings.model,
    settings.api,
    baseEnv,
    securityArgs,
    timeoutMs,
    compactCwd
  );

  return ok
    ? { success: true, message: `✅ Session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

// Compact a Discord thread session by threadId. Uses getThreadSession (not getSession)
// because Discord threads have their own session store. agentName is used only for cwd isolation.
export async function compactCurrentThreadSession(
  threadId: string,
  agentName?: string
): Promise<{ success: boolean; message: string }> {
  const existing = await getThreadSession(threadId);
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const securityArgs = buildSecurityArgs(settings.security);
  const baseEnv = cleanSpawnEnv();
  const timeoutMs = settings.sessionTimeoutMs;

  const compactCwd = agentName ? await ensureAgentDir(agentName) : undefined;
  const ok = await runCompact(
    existing.sessionId,
    settings.model,
    settings.api,
    baseEnv,
    securityArgs,
    timeoutMs,
    compactCwd
  );

  return ok
    ? { success: true, message: `✅ Thread session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

async function execClaude(
  name: string,
  prompt: string,
  threadId?: string,
  modelOverride?: string,
  timeoutMsOverride?: number,
  agentName?: string
): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = threadId
    ? await getThreadSession(threadId)
    : await getSession(agentName);
  const isNew = !existing;
  // Start the watchdog clock for resumed sessions (we know the ID immediately).
  if (existing) startSession(existing.sessionId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const settings = getSettings();
  const { security, model, api, fallback, agentic, watchdog } = settings;

  // Determine which model to use based on agentic routing
  let primaryConfig: ModelConfig;
  let taskType = "unknown";
  let routingReasoning = "";

  if (modelOverride) {
    primaryConfig = { model: modelOverride, api };
    console.log(`[${new Date().toLocaleTimeString()}] Job model override: ${modelOverride}`);
  } else if (agentic.enabled) {
    const routing = selectModel(prompt, agentic.modes, agentic.defaultMode);
    primaryConfig = { model: routing.model, api };
    taskType = routing.taskType;
    routingReasoning = routing.reasoning;
    console.log(
      `[${new Date().toLocaleTimeString()}] Agentic routing: ${routing.taskType} → ${routing.model} (${routing.reasoning})`
    );
  } else {
    primaryConfig = { model, api };
  }

  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);
  const timeoutMs = timeoutMsOverride ?? settings.sessionTimeoutMs;

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // Plugins: before_agent_start — fired before Claude is invoked.
  const pm = getPluginManager();
  const ctx = pluginCtx(threadId, agentName);
  if (pm) await pm.emit("before_agent_start", { prompt }, ctx);

  // stream-json emits NDJSON events as Claude works, including during subagent (Task tool)
  // orchestration. This keeps the process alive and producing output rather than silently
  // blocking until all spawned agents finish. --verbose is required for stream-json in
  // print (-p) mode. Session ID is captured from the system/init event; the final result
  // text comes from the result event — no separate output format needed for new vs resumed.
  const args = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing.sessionId);
  }

  // Build the appended system prompt: CLAUDE.md + directory scoping
  // This is passed on EVERY invocation (not just new sessions) because
  // --append-system-prompt does not persist across --resume.
  // Prompt files (IDENTITY.md, USER.md, SOUL.md) are already embedded in
  // CLAUDE.md by ensureProjectClaudeMd(), which runs before every call.
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
  ];

  try {
    const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
    if (claudeMd.trim()) appendParts.push(claudeMd.trim());
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
  }

  // Plugins: before_prompt_build — lets plugins inject system context
  if (pm) {
    const pluginResult = await pm.emit("before_prompt_build", { prompt }, ctx);
    if (pluginResult?.appendSystemContext) appendParts.push(pluginResult.appendSystemContext);
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const baseEnv = cleanSpawnEnv();
  const spawnCwd = agentName ? await ensureAgentDir(agentName) : undefined;

  let exec = await runClaudeStream(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs, spawnCwd);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    const fallbackSession = await getFallbackSession(agentName);
    const fallbackArgs = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];
    if (fallbackSession) {
      fallbackArgs.push("--resume", fallbackSession.sessionId);
    }
    if (appendParts.length > 0) {
      fallbackArgs.push("--append-system-prompt", appendParts.join("\n\n"));
    }
    exec = await runClaudeStream(fallbackArgs, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs, spawnCwd);
    usedFallback = true;
    const fallbackRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
    if (!fallbackRateLimit) {
      if (!fallbackSession && exec.sessionId) {
        await createFallbackSession(exec.sessionId, agentName);
        const label = agentName ? ` (agent ${agentName})` : "";
        console.log(`[${new Date().toLocaleTimeString()}] Fallback session created: ${exec.sessionId}${label}`);
      } else if (fallbackSession) {
        await incrementFallbackTurn(agentName);
      }
    }
  }

  const rawStdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  let stdout = rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";
  const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  }

  // Surface stderr when the result event never arrived (abort, tool error, etc.)
  if (!rateLimitMessage && exitCode !== 0 && !stdout && stderr) {
    stdout = stderr;
  }

  // Capture session ID from stream events and persist for new sessions.
  // Gate only on isNew + sessionId present — not on exitCode, so a session that timed
  // out mid-run is still persisted and can be resumed on the next message.
  if (!rateLimitMessage && isNew && exec.sessionId && !usedFallback) {
    sessionId = exec.sessionId;
    if (threadId) {
      await createThreadSession(threadId, sessionId);
      console.log(`[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`);
    } else {
      await createSession(sessionId, agentName);
      const label = agentName ? ` (agent ${agentName})` : "";
      console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}${label}`);
    }
    startSession(sessionId);
  }

  const result: RunResult = {
    stdout,
    stderr,
    exitCode,
  };

  // Plugins: agent_end — fire-and-forget, does not block response
  if (pm && exitCode === 0) {
    pm.emitAsync("agent_end", {
      messages: [{ role: "assistant", content: stdout }],
    }, ctx);
  }

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    ...(agentic.enabled ? [`Task type: ${taskType}`, `Routing: ${routingReasoning}`] : []),
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  // --- Watchdog: track consecutive timeouts ---
  // Skip tracking for unresolved session IDs ("unknown") to avoid cross-session
  // state collisions when a new session fails before its real ID is known.
  const trackingId = sessionId !== "unknown" ? sessionId : null;
  if (trackingId) {
    if (exitCode === 0) {
      clearSession(trackingId);
    } else {
      recordResult(trackingId, exitCode);
      const reason = abortReason(trackingId, watchdog);
      if (reason) {
        console.warn(`[${new Date().toLocaleTimeString()}] ${reason}`);
        clearSession(trackingId);
        return result;
      }
      // Non-timeout, non-zero exits: counter is already reset by recordResult.
      // Do NOT clearSession here — that would reset startedAt and weaken maxRuntimeSeconds.
    }
  }

  // --- Auto-compact on timeout (exit 124) ---
  if (COMPACT_TIMEOUT_ENABLED && exitCode === 124 && !isNew && existing) {
    emitCompactEvent({ type: "auto-compact-start" });
    const compactOk = await runCompact(
      existing.sessionId,
      primaryConfig.model,
      primaryConfig.api,
      baseEnv,
      securityArgs,
      timeoutMs,
      spawnCwd
    );
    emitCompactEvent({ type: "auto-compact-done", success: compactOk });
    if (compactOk && pm) pm.emitAsync("after_compaction", {}, ctx);

    if (compactOk) {
      console.log(`[${new Date().toLocaleTimeString()}] Retrying ${name} after compact...`);
      const retryExec = await runClaudeStream(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs, spawnCwd);
      const retryResult: RunResult = {
        stdout: retryExec.rawStdout,
        stderr: retryExec.stderr,
        exitCode: retryExec.exitCode,
      };
      emitCompactEvent({
        type: "auto-compact-retry",
        success: retryExec.exitCode === 0,
        stdout: retryResult.stdout,
        stderr: retryResult.stderr,
        exitCode: retryResult.exitCode,
      });

      if (retryExec.exitCode === 0) {
        const count = threadId ? await incrementThreadTurn(threadId) : await incrementTurn(agentName);
        console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`);
      }
      return retryResult;
    }
  }

  // --- Turn tracking & compact warning ---
  if (exitCode === 0 && !isNew) {
    const turnCount = threadId ? await incrementThreadTurn(threadId) : await incrementTurn(agentName);
    const turnLabel = threadId ? ` (thread ${threadId.slice(0, 8)})` : agentName ? ` (agent ${agentName})` : "";
    console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${turnCount}${turnLabel}`);

    if (turnCount >= COMPACT_WARN_THRESHOLD && existing && !existing.compactWarned) {
      if (threadId) {
        await markThreadCompactWarned(threadId);
      } else {
        await markCompactWarned(agentName);
      }
      emitCompactEvent({ type: "warn", turnCount });
    }
  }

  return result;
}

export async function run(
  name: string,
  prompt: string,
  threadId?: string,
  modelOverride?: string,
  timeoutMs?: number,
  agentName?: string
): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt, threadId, modelOverride, timeoutMs, agentName), threadId);
}

async function streamClaude(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void
): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = await getSession();
  const { security, model, api } = getSettings();
  const securityArgs = buildSecurityArgs(security);

  // Plugins: before_agent_start
  const streamPm = getPluginManager();
  const streamCtx = pluginCtx();
  if (streamPm) await streamPm.emit("before_agent_start", { prompt }, streamCtx);

  // stream-json gives us events as they happen — text before tool calls,
  // so we can unblock the UI as soon as Claude acknowledges, not after sub-agents finish.
  // --verbose is required for stream-json to produce output in -p (print) mode.
  const args = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

  if (existing) args.push("--resume", existing.sessionId);

  const appendParts: string[] = ["You are running inside ClaudeClaw."];

  try {
    const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
    if (claudeMd.trim()) appendParts.push(claudeMd.trim());
  } catch {}

  // Plugins: before_prompt_build
  if (streamPm) {
    const pluginResult = await streamPm.emit("before_prompt_build", { prompt }, streamCtx);
    if (pluginResult?.appendSystemContext) appendParts.push(pluginResult.appendSystemContext);
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const childEnv = buildChildEnv(cleanSpawnEnv(), model, api);

  console.log(`[${new Date().toLocaleTimeString()}] Running: ${name} (stream-json, session: ${existing?.sessionId?.slice(0, 8) ?? "new"})`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let unblocked = false;
  let textEmitted = false;

  const maybeUnblock = () => {
    if (!unblocked) {
      unblocked = true;
      onUnblock();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Parse complete newline-delimited JSON events
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;

        if (event.type === "system" && (event.subtype === "init" || event.session_id)) {
          // Capture session ID for new sessions
          const sid = event.session_id as string | undefined;
          if (sid && !existing) {
            await createSession(sid);
            console.log(`[${new Date().toLocaleTimeString()}] Session created (stream-json): ${sid}`);
          }
        } else if (event.type === "assistant") {
          // Text and tool_use blocks from the assistant
          type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
          const msg = event.message as { content?: ContentBlock[] } | undefined;
          const blocks = msg?.content ?? [];
          let hasActivity = false;
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              onChunk(block.text);
              textEmitted = true;
              hasActivity = true;
            } else if (block.type === "tool_use") {
              hasActivity = true;
              if (streamPm && block.name) {
                streamPm.emitAsync("tool_result_persist", {
                  toolName: block.name,
                  params: block.input ?? {},
                  message: { content: [{ type: "text", text: JSON.stringify(block.input ?? {}).slice(0, 500) }] },
                }, streamCtx);
              }
            }
          }
          if (hasActivity) maybeUnblock();
        } else if (event.type === "tool_use") {
          // Top-level tool_use event (some stream-json versions) — unblock the UI
          maybeUnblock();
        } else if (event.type === "result") {
          // Final result event — emit text as fallback if no assistant text was seen
          const resultText = (event as Record<string, unknown>).result as string | undefined;
          if (resultText && !textEmitted) {
            onChunk(resultText);
          }
          maybeUnblock();
        }
      } catch {}
    }
  }

  await proc.exited;
  // Ensure unblock fires even if something unexpected happened
  maybeUnblock();

  // Plugins: agent_end
  if (streamPm) streamPm.emitAsync("agent_end", { messages: [] }, streamCtx);

  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name}`);
}

export async function streamUserMessage(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void
): Promise<void> {
  return enqueue(() => streamClaude(name, prefixUserMessageWithClock(prompt), onChunk, onUnblock));
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(name: string, prompt: string, threadId?: string, agentName?: string): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), threadId, undefined, undefined, agentName);
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  await execClaude("bootstrap", "Wakeup, my friend!");
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}
