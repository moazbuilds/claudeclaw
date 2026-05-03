import { mkdir, readFile, writeFile, realpath } from "fs/promises";
import { join, dirname, resolve, sep } from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";
import {
  getSession,
  createSession,
  resetSession,
  incrementTurn,
  markCompactWarned,
  getFallbackSession,
  createFallbackSession,
  resetFallbackSession,
  incrementFallbackTurn,
  peekSession,
  incrementMessageCount,
  backupSession,
} from "./sessions";
import { needsRotation, rotateSession, loadLatestSummary } from "./rotation";
import {
  getThreadSession,
  createThreadSession,
  removeThreadSession,
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
 * On Windows, `claude` resolves to `claude.cmd`, a batch wrapper that must
 * be run through cmd.exe (8191-char command-line limit). Resolving the
 * underlying `claude.exe` lets us call it directly via CreateProcessW
 * (32767-char limit). Required because --append-system-prompt + prompt
 * files + CLAUDE.md can easily exceed 8K.
 */
function resolveClaudeExecutable(): string {
  if (process.platform !== "win32") return "claude";
  try {
    const out = execSync("where claude", { encoding: "utf8" });
    const cmdPath = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().endsWith(".cmd"));
    if (!cmdPath) return "claude";
    const exePath = join(
      dirname(cmdPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    return existsSync(exePath) ? exePath : "claude";
  } catch {
    return "claude";
  }
}
const CLAUDE_EXECUTABLE = resolveClaudeExecutable();

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

export interface AgentStreamEvent {
  type: "spawn" | "done";
  id: string;
  description: string;
  result?: string;
}

const RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit|out of extra usage/i;
const RATE_LIMIT_RESET_PATTERN = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*UTC\s*\)?/i;
const SIGNATURE_ERROR = /Invalid.*signature.*thinking block/i;

// Claude Code prints this when --resume references a session it no longer
// has on disk (cleared, expired, compacted away, or moved to another machine).
// When we see it, the cached session ID is dead and the only recovery is to
// drop --resume and start fresh.
const STALE_SESSION_PATTERN = /No conversation found with session ID/i;

function isStaleSessionError(stdout: string, stderr: string): boolean {
  return STALE_SESSION_PATTERN.test(stderr) || STALE_SESSION_PATTERN.test(stdout);
}

/** Strip --resume <id> from a claude argv list so it runs as a brand-new session. */
function stripResume(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      i += 1; // skip the session id that follows
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

/** Replace the value following --output-format (returns a modified copy). */
function withOutputFormat(args: string[], format: string): string[] {
  const out = [...args];
  const idx = out.indexOf("--output-format");
  if (idx >= 0 && idx + 1 < out.length) out[idx + 1] = format;
  return out;
}

// --- Rate limit state ---
let rateLimitResetAt: number = 0; // epoch ms; 0 = not rate-limited
let rateLimitNotified: boolean = false;

function parseRateLimitResetTime(text: string): number | null {
  const match = text.match(RATE_LIMIT_RESET_PATTERN);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const ampm = match[3]?.toLowerCase();

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(hours, minutes, 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset.getTime();
}

export function isRateLimited(): boolean {
  if (rateLimitResetAt === 0) return false;
  if (Date.now() >= rateLimitResetAt) {
    rateLimitResetAt = 0;
    rateLimitNotified = false;
    return false;
  }
  return true;
}

export function getRateLimitResetAt(): number {
  return rateLimitResetAt;
}

export function wasRateLimitNotified(): boolean {
  return rateLimitNotified;
}

export function markRateLimitNotified(): void {
  rateLimitNotified = true;
}

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

// Track active main-queue subprocesses so /kill targets them exclusively.
// Using a Set because per-thread queues run in parallel — multiple main
// runs can be in-flight at the same time. Fork procs are excluded: they run
// outside the main queue and must not be killed by /kill.
const mainActiveProcs = new Set<ReturnType<typeof Bun.spawn>>();

/** Kill all running main-queue claude subprocesses. Returns true if anything was killed. */
export function killActive(): boolean {
  if (mainActiveProcs.size === 0) return false;
  for (const proc of mainActiveProcs) {
    try { proc.kill(); } catch {}
  }
  mainActiveProcs.clear();
  return true;
}

// Counter rather than boolean: per-thread queues run in parallel so
// multiple main runs can be in-flight simultaneously.
let mainRunCount = 0;

/** True while any main-queue agent is processing a task (excludes fork). */
export function isMainBusy(): boolean {
  return mainRunCount > 0;
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

/**
 * Resolve the subprocess timeout (in ms) for a given invocation category.
 * Values are read fresh from settings on every call, so hot-reload works
 * automatically: edit settings.json and the next subprocess picks it up.
 *
 * Category mapping:
 *   "telegram"  → settings.timeouts.telegram  (default 5 min)
 *   "heartbeat" → settings.timeouts.heartbeat (default 15 min)
 *   "job"       → settings.timeouts.job       (default 30 min)
 *   anything else (bootstrap, trigger, chat…) → settings.timeouts.default (default 5 min)
 *
 * Use execClaude's `timeoutCategory` param to pass the category separately from
 * the display/log/session name (e.g. scheduled jobs use job.name for the session
 * ID but pass "job" as the category so they get timeouts.job, not timeouts.default).
 */
function resolveTimeoutMs(name: string): number {
  const t = getSettings().timeouts;
  let minutes: number;
  if (name === "telegram") {
    minutes = t.telegram;
  } else if (name === "heartbeat") {
    minutes = t.heartbeat;
  } else if (name === "job") {
    minutes = t.job;
  } else {
    minutes = t.default;
  }
  return minutes * 60_000;
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

  mainActiveProcs.add(proc);
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
    mainActiveProcs.delete(proc);

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    mainActiveProcs.delete(proc);
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
  cwd?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void
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

  mainActiveProcs.add(proc);
  let sessionId: string | undefined;
  let resultText = "";
  let stderr = "";

  // Streaming state for onChunk/onToolEvent callbacks
  let streamDelivered = "";
  let streamLastMsgId = "";
  const streamPendingToolCalls = new Map<string, string>();

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
          // Emit streaming callbacks if provided
          if ((onChunk || onToolEvent) && event.type === "assistant" && (event.message as any)?.content) {
            const msg = event.message as any;
            const msgId: string = msg.id ?? "";
            if (msgId !== streamLastMsgId) {
              if (onChunk && streamDelivered) onChunk("\n");
              streamDelivered = "";
              streamLastMsgId = msgId;
            }
            let full = "";
            for (const block of msg.content) {
              if (block.type === "text" && typeof block.text === "string") {
                full += block.text;
              } else if (block.type === "tool_use" && onToolEvent) {
                streamPendingToolCalls.set(block.id, block.name);
                onToolEvent(`● ${formatToolCallSummary(block.name, block.input ?? {})}`);
              }
            }
            if (onChunk && full.length > streamDelivered.length) {
              onChunk(full.slice(streamDelivered.length));
              streamDelivered = full;
            }
          }
          if (onToolEvent && event.type === "user") {
            for (const block of (event.message as any)?.content ?? []) {
              if (block.type === "tool_result") {
                const toolName = streamPendingToolCalls.get(block.tool_use_id) ?? "?";
                streamPendingToolCalls.delete(block.tool_use_id);
                const text = extractToolResultText(block.content);
                const firstLine = text.split("\n")[0].slice(0, 80);
                const summary = block.is_error ? `Error: ${firstLine}` : (firstLine || "done");
                onToolEvent(`  ⎿  [${toolName}] ${summary}`);
              }
            }
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
    mainActiveProcs.delete(proc);
    return { rawStdout: resultText, stderr: stderr.trim(), exitCode: proc.exitCode ?? 1, sessionId };
  } catch (err) {
    if (streamJsonTimeoutId) clearTimeout(streamJsonTimeoutId);
    mainActiveProcs.delete(proc);
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);
    return { rawStdout: "", stderr: message, exitCode: 124, sessionId };
  }
}

function formatToolCallSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 50) => String(v ?? "").slice(0, max);
  switch (name) {
    case "Write":
    case "Edit":
    case "Read":    return `${name}(${s(input.file_path)})`;
    case "Bash":    return `Bash(${s(input.command, 60)})`;
    case "Grep":    return `Grep(${s(input.pattern)} in ${s(input.path ?? ".")})`;
    case "Glob":    return `Glob(${s(input.pattern)})`;
    case "WebSearch": return `WebSearch(${s(input.query)})`;
    case "WebFetch":  return `WebFetch(${s(input.url, 60)})`;
    default:        return `${name}(...)`;
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

/**
 * Run claude with --output-format stream-json, emitting text chunks via onChunk
 * and tool call/result lines via onToolEvent as they arrive.
 * Session ID and final result come from the result event.
 * Unlike runClaudeStream, this function is for real-time delivery to external surfaces
 * (e.g. Telegram streaming) and does NOT use a timeout — callers must handle that.
 */
async function runClaudeStreaming(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void
): Promise<{ result: string; stderr: string; exitCode: number; sessionId?: string; isRateLimit: boolean }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  mainActiveProcs.add(proc);
  const stderrPromise = new Response(proc.stderr).text();

  let finalResult = "";
  let sessionId: string | undefined;
  let isRateLimit = false;
  let delivered = ""; // text already sent to onChunk for the current message
  let lastMsgId = ""; // reset delivered tracking when a new assistant message starts
  const pendingToolCalls = new Map<string, string>(); // tool_use_id → tool name

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      try {
        const event = JSON.parse(line);

        if (event.type === "assistant" && event.message?.content) {
          const msgId: string = event.message.id ?? "";
          if (msgId !== lastMsgId) {
            // Insert newline separator between assistant messages so text
            // from successive turns doesn't merge onto one line.
            if (onChunk && delivered) onChunk("\n");
            delivered = "";
            lastMsgId = msgId;
          }
          let full = "";
          for (const block of event.message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              full += block.text;
            } else if (block.type === "tool_use" && onToolEvent) {
              pendingToolCalls.set(block.id, block.name);
              onToolEvent(`● ${formatToolCallSummary(block.name, block.input ?? {})}`);
            }
          }
          if (onChunk && full.length > delivered.length) {
            onChunk(full.slice(delivered.length));
            delivered = full;
          }
        }

        if (event.type === "user" && onToolEvent) {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_result") {
              const name = pendingToolCalls.get(block.tool_use_id) ?? "?";
              pendingToolCalls.delete(block.tool_use_id);
              const text = extractToolResultText(block.content);
              const firstLine = text.split("\n")[0].slice(0, 80);
              const summary = block.is_error ? `Error: ${firstLine}` : (firstLine || "done");
              onToolEvent(`  ⎿  [${name}] ${summary}`);
            }
          }
        }

        if (event.type === "result") {
          sessionId = event.session_id;
          finalResult = typeof event.result === "string" ? event.result : finalResult;
          isRateLimit = RATE_LIMIT_PATTERN.test(finalResult);
        }
      } catch {}
    }
  }

  await proc.exited;
  mainActiveProcs.delete(proc);

  const stderr = await stderrPromise;
  // Also check stderr for rate limit signals
  if (!isRateLimit) isRateLimit = RATE_LIMIT_PATTERN.test(stderr);

  return { result: finalResult, stderr, exitCode: proc.exitCode ?? 1, sessionId, isRateLimit };
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
    CLAUDE_EXECUTABLE, "-p", "/compact",
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
  agentName?: string,
  timeoutCategory?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void
): Promise<RunResult> {
  mainRunCount++;
  try {
  await mkdir(LOGS_DIR, { recursive: true });

  // Rotate the global session if thresholds are exceeded (thread/agent sessions are not rotated).
  let rotationSummary: string | null = null;
  if (!threadId && !agentName) {
    const { session: sessionConfig } = getSettings();
    if (sessionConfig.autoRotate) {
      const peeked = await peekSession();
      if (peeked && needsRotation(peeked, sessionConfig)) {
        rotationSummary = await rotateSession(sessionConfig);
      }
    }
  }

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
  const timeoutMs = timeoutMsOverride ?? resolveTimeoutMs(timeoutCategory ?? name);

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level}, timeout: ${timeoutMs / 60_000}m)`
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
  const args = [CLAUDE_EXECUTABLE, "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

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

  if (rotationSummary) appendParts.push(`Context from the previous session:\n\n${rotationSummary}`);

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

  let exec = await runClaudeStream(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs, spawnCwd, onChunk, onToolEvent);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    const fallbackSession = await getFallbackSession(agentName, threadId);
    const fallbackArgs = [CLAUDE_EXECUTABLE, "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];
    if (fallbackSession) {
      fallbackArgs.push("--resume", fallbackSession.sessionId);
    }
    if (appendParts.length > 0) {
      fallbackArgs.push("--append-system-prompt", appendParts.join("\n\n"));
    }
    exec = await runClaudeStream(fallbackArgs, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs, spawnCwd);
    usedFallback = true;
    let fallbackRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);

    // If the fallback resumed a corrupted session, reset it and retry fresh.
    if (!fallbackRateLimit && fallbackSession && exec.exitCode !== 0 && SIGNATURE_ERROR.test(exec.rawStdout + exec.stderr)) {
      await resetFallbackSession(agentName, threadId);
      const flabel = threadId ? ` (thread ${threadId.slice(0, 8)})` : agentName ? ` (agent ${agentName})` : "";
      console.warn(
        `[${new Date().toLocaleTimeString()}] Detected corrupted fallback session (thinking block signature mismatch). Reset${flabel}, retrying fallback fresh...`
      );
      const freshFallbackArgs = fallbackArgs.filter((a) => a !== "--resume" && a !== fallbackSession.sessionId);
      exec = await runClaudeStream(freshFallbackArgs, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs, spawnCwd);
      fallbackRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
      if (!fallbackRateLimit && exec.sessionId) {
        await createFallbackSession(exec.sessionId, agentName, threadId);
        console.log(`[${new Date().toLocaleTimeString()}] Fallback session recovered: ${exec.sessionId}${flabel}`);
      }
    } else if (!fallbackRateLimit) {
      if (!fallbackSession && exec.sessionId) {
        await createFallbackSession(exec.sessionId, agentName, threadId);
        const label = threadId ? ` (thread ${threadId.slice(0, 8)})` : agentName ? ` (agent ${agentName})` : "";
        console.log(`[${new Date().toLocaleTimeString()}] Fallback session created: ${exec.sessionId}${label}`);
      } else if (fallbackSession) {
        await incrementFallbackTurn(agentName, threadId);
      }
    }
  }

  let rawStdout = exec.rawStdout;
  let stderr = exec.stderr;
  let exitCode = exec.exitCode;
  let stdout = rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";

  // Auto-detect corrupted primary session from thinking block signature mismatch.
  // Gated on !usedFallback — fallback corruption is handled inside the fallback block above.
  if (exitCode !== 0 && !isNew && !usedFallback && SIGNATURE_ERROR.test(rawStdout + stderr)) {
    if (threadId) {
      await removeThreadSession(threadId);
    } else if (agentName) {
      await resetSession(agentName);
    } else {
      await backupSession();
    }
    const label = threadId ? ` (thread ${threadId.slice(0, 8)})` : agentName ? ` (agent ${agentName})` : "";
    console.warn(
      `[${new Date().toLocaleTimeString()}] Detected corrupted session (thinking block signature mismatch). Reset${label}, retrying with fresh session...`
    );
    const freshArgs = args.filter((a) => a !== "--resume" && a !== existing?.sessionId);
    const fmtIdx = freshArgs.indexOf("--output-format");
    if (fmtIdx !== -1 && fmtIdx + 1 < freshArgs.length) freshArgs[fmtIdx + 1] = "stream-json";
    exec = await runClaudeStream(freshArgs, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs, spawnCwd);
    rawStdout = exec.rawStdout;
    stderr = exec.stderr;
    exitCode = exec.exitCode;
    stdout = rawStdout;

    // Persist the fresh session ID so subsequent calls resume it correctly.
    if (exec.sessionId) {
      sessionId = exec.sessionId;
      if (threadId) {
        await createThreadSession(threadId, sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Thread session recovered: ${sessionId} (thread ${threadId.slice(0, 8)})`);
      } else {
        await createSession(sessionId, agentName);
        const sLabel = agentName ? ` (agent ${agentName})` : "";
        console.log(`[${new Date().toLocaleTimeString()}] Session recovered: ${sessionId}${sLabel}`);
      }
      startSession(sessionId);
    }
  }

  let recoveredFromStale = false;

  // --- Stale session recovery ---
  // Claude Code returns "No conversation found with session ID: <id>" when
  // --resume points at a session it no longer has (cleared, expired, etc.).
  // Back up the dead ID, drop --resume, and retry as a new session so the
  // user isn't permanently stuck.
  if (
    !isNew &&
    exitCode !== 0 &&
    existing &&
    isStaleSessionError(rawStdout, stderr)
  ) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Stale session ${existing.sessionId.slice(0, 8)} for ${name}; recovering with a new session...`
    );

    if (usedFallback) {
      await resetFallbackSession(agentName, threadId);
    } else if (threadId) {
      await removeThreadSession(threadId);
    } else if (agentName) {
      await resetSession(agentName);
    } else {
      await backupSession();
    }

    const retryArgs = withOutputFormat(stripResume(args), "stream-json");
    const retryConfig = usedFallback ? fallbackConfig : primaryConfig;
    exec = await runClaudeStream(
      retryArgs,
      retryConfig.model,
      retryConfig.api,
      baseEnv,
      timeoutMs,
      spawnCwd
    );

    rawStdout = exec.rawStdout;
    stderr = exec.stderr;
    exitCode = exec.exitCode;
    stdout = rawStdout;
    recoveredFromStale = true;
  }

  const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
    const resetTime = parseRateLimitResetTime(rateLimitMessage);
    rateLimitResetAt = resetTime ?? (Date.now() + 60 * 60_000);
    rateLimitNotified = false;
    console.warn(
      `[${new Date().toLocaleTimeString()}] Rate limit detected. Reset at: ${new Date(rateLimitResetAt).toISOString()}`
    );
  }

  // Surface stderr when the result event never arrived (abort, tool error, etc.)
  if (!rateLimitMessage && exitCode !== 0 && !stdout && stderr) {
    stdout = stderr;
  }

  // Capture session ID from stream events and persist for new sessions.
  // Gate only on isNew + sessionId present — not on exitCode, so a session that timed
  // out mid-run is still persisted and can be resumed on the next message.
  const parseAsNew = isNew || recoveredFromStale;
  if (!rateLimitMessage && parseAsNew && exec.sessionId) {
    sessionId = exec.sessionId;
    if (recoveredFromStale && usedFallback) {
      await createFallbackSession(sessionId, agentName, threadId);
      const label = threadId ? ` (thread ${threadId.slice(0, 8)})` : agentName ? ` (agent ${agentName})` : "";
      console.log(`[${new Date().toLocaleTimeString()}] Fallback session created: ${sessionId}${label}`);
      startSession(sessionId);
    } else if (!usedFallback) {
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
  // Count this invocation for rotation tracking (global session only; agent sessions don't rotate).
  if (!agentName && !threadId) await incrementMessageCount();
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
  if (COMPACT_TIMEOUT_ENABLED && exitCode === 124 && !isNew && existing && !recoveredFromStale) {
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
  if (exitCode === 0 && !isNew && !recoveredFromStale) {
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
  } finally {
    mainRunCount--;
  }
}

export async function run(
  name: string,
  prompt: string,
  threadId?: string,
  modelOverride?: string,
  timeoutMs?: number,
  agentName?: string,
  timeoutCategory?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void
): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt, threadId, modelOverride, timeoutMs, agentName, timeoutCategory, onChunk, onToolEvent), threadId);
}

async function streamClaude(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  onAgentEvent?: (ev: AgentStreamEvent) => void
): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });

  // Rotate the global session if thresholds are exceeded (mirrors the check in execClaude).
  let streamRotationSummary: string | null = null;
  const { session: streamSessionConfig } = getSettings();
  if (streamSessionConfig.autoRotate) {
    const streamPeeked = await peekSession();
    if (streamPeeked && needsRotation(streamPeeked, streamSessionConfig)) {
      streamRotationSummary = await rotateSession(streamSessionConfig);
    }
  }

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
  const args = [CLAUDE_EXECUTABLE, "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

  if (existing) args.push("--resume", existing.sessionId);

  const appendParts: string[] = ["You are running inside ClaudeClaw."];

  if (streamRotationSummary) appendParts.push(`Context from the previous session:\n\n${streamRotationSummary}`);

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

  // Collect stderr in the background so it doesn't back-pressure the process.
  // We need it after proc.exited for stale session detection.
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let unblocked = false;
  let textEmitted = false;
  // Track pending Agent tool calls: tool_use_id → description
  const pendingAgents = new Map<string, string>();

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
            }
            // Detect Agent tool spawns and emit lifecycle event
            if (block.type === "tool_use" && block.name === "Agent" && block.id && onAgentEvent) {
              const description = String(block.input?.description ?? block.input?.prompt ?? "Running background task...");
              pendingAgents.set(block.id, description);
              onAgentEvent({ type: "spawn", id: block.id, description });
              hasActivity = true;
            }
            // Always emit plugin observation for all tool_use blocks (including Agent)
            if (block.type === "tool_use") {
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
        } else if (event.type === "user") {
          // Tool results come back as user messages — match Agent completions
          type ToolResultBlock = { type: string; tool_use_id?: string; content?: unknown };
          const msg = event.message as { content?: ToolResultBlock[] } | undefined;
          const blocks = msg?.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_result" && block.tool_use_id && pendingAgents.has(block.tool_use_id)) {
              const description = pendingAgents.get(block.tool_use_id)!;
              pendingAgents.delete(block.tool_use_id);
              const result = typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? "");
              if (onAgentEvent) onAgentEvent({ type: "done", id: block.tool_use_id, description, result });
            }
          }
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
  const stderrText = await stderrPromise;

  // --- Stale session recovery (stream path) ---
  if (
    existing &&
    !textEmitted &&
    (proc.exitCode ?? 0) !== 0 &&
    isStaleSessionError("", stderrText)
  ) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Stale session ${existing.sessionId.slice(0, 8)} for ${name} (stream); recovering with a new session...`
    );
    await backupSession();
    await streamClaude(name, prompt, onChunk, onUnblock, onAgentEvent);
    return;
  }

  // Ensure unblock fires even if something unexpected happened
  maybeUnblock();

  // Plugins: agent_end
  if (streamPm) streamPm.emitAsync("agent_end", { messages: [] }, streamCtx);

  // Count this invocation for rotation tracking.
  await incrementMessageCount();

  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name}`);
}

export async function streamUserMessage(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  onAgentEvent?: (ev: AgentStreamEvent) => void
): Promise<void> {
  return enqueue(() => streamClaude(name, prefixUserMessageWithClock(prompt), onChunk, onUnblock, onAgentEvent));
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

export async function runUserMessage(
  name: string,
  prompt: string,
  threadId?: string,
  agentName?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void
): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), threadId, undefined, undefined, agentName, undefined, onChunk, onToolEvent);
}

// Path where Claude Code stores session JSONL transcripts for this project
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/root",
  ".claude",
  "projects",
  PROJECT_DIR.replace(/\//g, "-")
);

const FORK_SYSTEM_PROMPT = [
  "You are a FORK AGENT — a fast, lightweight watcher running in parallel with the main agent.",
  "",
  "SPEED IS YOUR PRIORITY. Be brief. Answer in 1-3 sentences. No preamble, no padding.",
  "Do NOT over-analyze. Do NOT think through edge cases. Just answer and stop.",
  "",
  "Your job: answer quick questions and peek at the main agent's progress via its session transcript.",
  "",
  "DENY immediately (one sentence explanation) any request that would take more than ~30 seconds:",
  "• Compiling / building anything (kernels, projects, binaries)",
  "• Downloads or network fetches",
  "• Fuzzing, long analysis, heavy computations",
  "• Anything that would block you and prevent monitoring/killing the main agent",
  "",
  "ALLOW:",
  "• Reading files (especially JSONL transcripts to report main agent progress)",
  "• Short factual answers",
  "• Reporting on what the main agent is currently doing",
  "",
  `Main session info lives at: /project/.claude/claudeclaw/session.json`,
  `Session JSONL transcripts dir: ${CLAUDE_SESSIONS_DIR}`,
  "To peek at main agent progress: read session.json for the session ID, then read the .jsonl file in the transcripts dir.",
  "Each JSONL line is a turn. The last few lines show what the main agent is currently doing.",
].join("\n");

const FORK_MODEL = "claude-haiku-4-5-20251001";

// Forks are lightweight watchers — hard-kill after 2 minutes.
const FORK_TIMEOUT_MS = 120_000;

/**
 * Run a fork agent — parallel, outside the main serial queue, no main session.
 *
 * Spawns directly rather than through runClaudeOnce so the fork proc is never
 * added to mainActiveProcs — /kill must only target main-queue runs, not forks.
 * Uses the same collectStream + timeout pattern as the main runner so forks
 * cannot hang indefinitely or grow memory unbounded.
 */
export async function runFork(prompt: string): Promise<RunResult> {
  const { api } = getSettings();
  const baseEnv = cleanSpawnEnv();

  const args = [
    CLAUDE_EXECUTABLE, "-p", prompt,
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--model", FORK_MODEL,
    "--append-system-prompt", FORK_SYSTEM_PROMPT,
  ];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, FORK_MODEL, api),
  });

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`Fork timed out after ${FORK_TIMEOUT_MS / 1000}s`));
    }, FORK_TIMEOUT_MS);
  });

  let rawStdout: string;
  let rawStderr: string;
  let exitCode: number;

  try {
    [rawStdout, rawStderr] = await Promise.race([
      Promise.all([
        collectStream(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
        collectStream(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
      ]),
      timeoutPromise,
    ]) as [string, string];
    if (timeoutId) clearTimeout(timeoutId);
    await proc.exited;
    exitCode = proc.exitCode ?? 1;
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    return { stdout: "", stderr: String(err), exitCode: 1 };
  }

  let stdout = rawStdout;
  if (exitCode === 0) {
    try {
      const json = JSON.parse(rawStdout);
      stdout = json.result ?? rawStdout;
    } catch {}
  }

  return { stdout, stderr: rawStderr, exitCode };
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  const { session: sessionConfig } = getSettings();
  const summary = sessionConfig.summaryPath ? await loadLatestSummary(sessionConfig.summaryPath) : null;
  const wakeupPrompt = summary
    ? `Wakeup, my friend!\n\nContext from the previous session:\n\n${summary}`
    : "Wakeup, my friend!";
  await execClaude("bootstrap", wakeupPrompt);
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}
