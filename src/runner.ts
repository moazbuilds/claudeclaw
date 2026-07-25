import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";

/**
 * On Windows, `claude` resolves to claude.cmd which runs via cmd.exe.
 * cmd.exe has an 8,191-char command-line limit, which the --append-system-prompt
 * value easily exceeds. Instead, find the native binary or Node entry point
 * and invoke it directly, bypassing cmd.exe entirely.
 */
function claudeEntryFromPackageDir(base: string): string[] | null {
  const exe = join(base, "bin", "claude.exe");
  if (existsSync(exe)) return [exe];
  const cjs = join(base, "cli-wrapper.cjs");
  if (existsSync(cjs)) return ["node", cjs];
  const js = join(base, "cli.js");
  if (existsSync(js)) return ["node", js];
  return null;
}

function resolveClaudeCmd(): string[] {
  if (process.platform !== "win32") return ["claude"];
  // Cheap filesystem probes first — `npm root -g` shells out to npm and can
  // block module load for seconds on Windows, so it's the last resort.
  if (process.env.APPDATA) {
    const found = claudeEntryFromPackageDir(
      join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code"),
    );
    if (found) return found;
  }
  try {
    const cmdPath = Bun.which("claude.cmd");
    if (cmdPath) {
      const found = claudeEntryFromPackageDir(
        join(dirname(cmdPath), "node_modules", "@anthropic-ai", "claude-code"),
      );
      if (found) return found;
    }
  } catch {}
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const found = claudeEntryFromPackageDir(join(npmRoot, "@anthropic-ai", "claude-code"));
    if (found) return found;
  } catch {}
  return ["claude"]; // last resort
}

export const CLAUDE_CMD = resolveClaudeCmd();
import { getSession, createSession, incrementTurn, markCompactWarned } from "./sessions";
import {
  getThreadSession,
  createThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
} from "./sessionManager";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { selectModel } from "./model-router";
import { classifyReadOnly, queryOllama, LOCAL_SIGIL } from "./ollama";
import { isAuthError, handleAuthFailure } from "./auth-guard";

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
const COMPACT_WARN_THRESHOLD = 10;
const COMPACT_TIMEOUT_ENABLED = true;

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

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RATE_LIMIT_PATTERN = /you.ve hit your limit|out of extra usage/i;

// Serial queue — prevents concurrent --resume on the same session
// Global queue for non-thread messages (backward compatible)
let globalQueue: Promise<unknown> = Promise.resolve();
// Per-thread queues — each thread runs independently in parallel
const threadQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  if (threadId) {
    const current = threadQueues.get(threadId) ?? Promise.resolve();
    const task = current.then(fn, fn);
    threadQueues.set(threadId, task.catch(() => {}));
    return task;
  }
  const task = globalQueue.then(fn, fn);
  globalQueue = task.catch(() => {});
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

/**
 * Bun.spawn() throws synchronously (not a rejected promise) when the target
 * executable doesn't exist. claude.exe briefly disappears mid self-update
 * (rename-then-write), so a spawn can hit that gap and throw ENOENT even
 * though the binary is back moments later. One short retry absorbs that race
 * instead of propagating an uncaught exception that would crash the daemon.
 */
// All call sites pipe stdout/stderr, so narrow the subprocess type accordingly
// (ReturnType<typeof Bun.spawn> widens streams to `number | ReadableStream`).
type PipedSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function spawnWithRetry(args: string[], opts: Parameters<typeof Bun.spawn>[1]): Promise<PipedSubprocess> {
  try {
    return Bun.spawn(args, opts) as PipedSubprocess;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    console.warn(`[${new Date().toLocaleTimeString()}] Spawn hit ENOENT (likely mid claude.exe self-update), retrying in 1.5s...`);
    await Bun.sleep(1500);
    return Bun.spawn(args, opts) as PipedSubprocess;
  }
}

// Unique temp-file names for --append-system-prompt-file. Concurrent thread
// sessions can hit the same Date.now() millisecond, so a per-process counter
// disambiguates.
let syspromptSeq = 0;
function nextSyspromptFile(): string {
  return join(LOGS_DIR, `sysprompt-${Date.now()}-${++syspromptSeq}.tmp`);
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

/** Default timeout for a single Claude Code invocation (5 minutes). */
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = CLAUDE_TIMEOUT_MS
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  let proc: PipedSubprocess;
  try {
    proc = await spawnWithRetry(args, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: buildChildEnv(baseEnv, model, api),
    });
  } catch (err) {
    // Spawn failed after retry — a bad-luck spawn now fails this one job,
    // not the whole daemon.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] Spawn failed after retry: ${message}`);
    return { rawStdout: "", stderr: message, exitCode: 127 };
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  try {
    const [rawStdout, stderr] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise,
    ]) as [string, string];
    await proc.exited;

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
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

const PROJECT_DIR = process.cwd();

/**
 * Build a clean environment for spawned claude subprocesses.
 * Strip vars that mark the current process as a Claude Code instance — these
 * cause the child to behave as a nested invocation (different, slower startup path).
 */
function buildCleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXECPATH;
  delete env.CLAUDE_CODE_GIT_BASH_PATH; // let child detect its own git bash
  return env;
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
  timeoutMs: number
): Promise<boolean> {
  const compactArgs = [
    ...CLAUDE_CMD, "-p", "/compact",
    "--output-format", "text",
    "--resume", sessionId,
    ...securityArgs,
  ];
  console.log(`[${new Date().toLocaleTimeString()}] Running /compact on session ${sessionId.slice(0, 8)}...`);
  const result = await runClaudeOnce(compactArgs, model, api, baseEnv, timeoutMs);
  const success = result.exitCode === 0;
  console.log(`[${new Date().toLocaleTimeString()}] Compact ${success ? "succeeded" : `failed (exit ${result.exitCode})`}`);
  return success;
}

/**
 * High-level compact: resolves session + settings internally.
 * Returns { success, message }.
 */
export async function compactCurrentSession(): Promise<{ success: boolean; message: string }> {
  const existing = await getSession();
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const securityArgs = buildSecurityArgs(settings.security);
  const baseEnv = buildCleanEnv();
  const timeoutMs = settings.sessionTimeoutMs ?? CLAUDE_TIMEOUT_MS;

  const ok = await runCompact(
    existing.sessionId,
    settings.model,
    settings.api,
    baseEnv,
    securityArgs,
    timeoutMs
  );

  return ok
    ? { success: true, message: `✅ Session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

async function execClaude(name: string, prompt: string, threadId?: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = threadId
    ? await getThreadSession(threadId)
    : await getSession();
  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const settings = getSettings();
  const { security, model, api, fallback, agentic } = settings;

  // Determine which model to use based on agentic routing
  let primaryConfig: ModelConfig;
  let taskType = "unknown";
  let routingReasoning = "";

  if (agentic.enabled) {
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
  const timeoutMs = settings.sessionTimeoutMs ?? CLAUDE_TIMEOUT_MS;

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // New session: use json output to capture Claude's session_id
  // Resumed session: use text output with --resume
  const outputFormat = isNew ? "json" : "text";
  const args = [...CLAUDE_CMD, "-p", prompt, "--output-format", outputFormat, ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing.sessionId);
  }

  // CLAUDE.md is auto-loaded by Claude Code from the project directory.
  // IDENTITY/USER/SOUL are embedded in the managed block inside CLAUDE.md.
  // We only append runtime-only context that isn't persisted anywhere.
  const appendParts: string[] = [];
  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

  // Write system prompt to a temp file to avoid Windows cmd.exe 8191-char command-line limit.
  const syspromptFile = nextSyspromptFile();
  if (appendParts.length > 0) {
    await writeFile(syspromptFile, appendParts.join("\n\n"), "utf8");
    args.push("--append-system-prompt-file", syspromptFile);
  }

  // Strip CLAUDECODE env var so child claude processes don't think they're nested
  const baseEnv = buildCleanEnv();

  // Ollama local routing — disabled, local model quality not sufficient yet
  // To re-enable: set ollama.enabled = true in settings.json
  // if (settings.ollama?.enabled) {
  //   const { classifierModel = "phi3:mini", readerModel = "llama3.2:3b" } = settings.ollama;
  //   try {
  //     const readOnly = await classifyReadOnly(prompt, classifierModel);
  //     if (readOnly) {
  //       console.log(`[${new Date().toLocaleTimeString()}] Ollama: read-only detected, routing locally`);
  //       const response = await queryOllama(prompt, readerModel);
  //       await Bun.write(logFile, [
  //         `# ${name}`, `Date: ${new Date().toISOString()}`, `Model: ollama/${readerModel} ${LOCAL_SIGIL}`,
  //         `Prompt: ${prompt}`, "", "## Output", response,
  //       ].join("\n"));
  //       return { stdout: response, stderr: "", exitCode: 0 };
  //     }
  //     console.log(`[${new Date().toLocaleTimeString()}] Ollama: write intent, routing to Claude`);
  //   } catch (err) {
  //     console.warn(`[${new Date().toLocaleTimeString()}] Ollama unavailable, falling through to Claude:`, err);
  //   }
  // }

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs);
    usedFallback = true;
  }

  // Claude auth is broken (expired/revoked key, login issue) rather than a
  // normal task failure — degrade to a local Ollama answer, or a single
  // clean status line, instead of returning the raw CLI error. This also
  // keeps exitCode at 0 below so callers (heartbeat, notify:"error" jobs)
  // don't forward the raw failure text to Discord/Telegram.
  if (exec.exitCode !== 0 && isAuthError(`${exec.stderr}\n${exec.rawStdout}`)) {
    console.warn(`[${new Date().toLocaleTimeString()}] Claude auth failure detected for ${name}; degrading gracefully...`);
    const fallback = await handleAuthFailure(prompt);
    const output = [
      `# ${name}`,
      `Date: ${new Date().toISOString()}`,
      `Model config: auth-fallback (${fallback.usedFallback})`,
      `Prompt: ${prompt}`,
      `Exit code: 0`,
      "",
      "## Output",
      fallback.stdout,
      "## Original error",
      exec.stderr || exec.rawStdout,
    ].join("\n");
    await Bun.write(logFile, output);
    if (appendParts.length > 0) unlink(syspromptFile).catch(() => {});
    console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile} (auth fallback: ${fallback.usedFallback})`);
    return { stdout: fallback.stdout, stderr: "", exitCode: 0 };
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

  // For new sessions, parse the JSON to extract session_id and result text
  if (!rateLimitMessage && isNew && exitCode === 0) {
    try {
      const json = JSON.parse(rawStdout);
      sessionId = json.session_id;
      stdout = json.result ?? "";
      // Save the real session ID from Claude Code
      if (threadId) {
        await createThreadSession(threadId, sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`);
      } else {
        await createSession(sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
      }
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to parse session from Claude output:`, e);
    }
  }

  const result: RunResult = {
    stdout,
    stderr,
    exitCode,
  };

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
  // Clean up temp system prompt file
  if (appendParts.length > 0) unlink(syspromptFile).catch(() => {});
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  // --- Auto-compact on timeout (exit 124) ---
  if (COMPACT_TIMEOUT_ENABLED && exitCode === 124 && !isNew && existing) {
    emitCompactEvent({ type: "auto-compact-start" });
    const compactOk = await runCompact(
      existing.sessionId,
      primaryConfig.model,
      primaryConfig.api,
      baseEnv,
      securityArgs,
      timeoutMs
    );
    emitCompactEvent({ type: "auto-compact-done", success: compactOk });

    if (compactOk) {
      console.log(`[${new Date().toLocaleTimeString()}] Retrying ${name} after compact...`);
      const retryExec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs);
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
        const count = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
        console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`);
      }
      return retryResult;
    }
  }

  // --- Turn tracking & compact warning ---
  if (exitCode === 0 && !isNew) {
    const turnCount = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
    console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${turnCount}${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`);

    if (turnCount >= COMPACT_WARN_THRESHOLD && existing && !existing.compactWarned) {
      if (threadId) {
        await markThreadCompactWarned(threadId);
      } else {
        await markCompactWarned();
      }
      emitCompactEvent({ type: "warn", turnCount });
    }
  }

  return result;
}

export async function run(name: string, prompt: string, threadId?: string): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt, threadId), threadId);
}

/**
 * Run a job's body as a shell command — no Claude session, no token cost.
 * Extracts the first ```bash ... ``` code block from the prompt and pipes it to bash -c.
 * Falls back to running the whole prompt as a script if no fence is found.
 */
export function extractShellBlock(prompt: string): string {
  const match = prompt.match(/```(?:bash|sh)?\s*\n([\s\S]*?)\n```/);
  return (match ? match[1] : prompt).trim();
}

async function execShell(name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);
  const script = extractShellBlock(prompt);

  console.log(`[${new Date().toLocaleTimeString()}] Running: ${name} (shell, no session)`);

  let proc: PipedSubprocess;
  try {
    proc = await spawnWithRetry(["bash", "-lc", script], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: buildCleanEnv(),
    });
  } catch (err) {
    // Spawn failed after retry — no session, so we can still write a
    // normal-shaped log entry instead of losing the failure silently.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] Spawn failed after retry: ${message}`);
    const output = [
      `# ${name}`,
      `Date: ${new Date().toISOString()}`,
      `Mode: shell (no Claude session)`,
      `Script: ${script.split("\n")[0]}${script.includes("\n") ? " ..." : ""}`,
      `Exit code: 127`,
      "",
      "## Output",
      "",
      "## Stderr",
      message,
    ].join("\n");
    await Bun.write(logFile, output);
    console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);
    return { stdout: "", stderr: message, exitCode: 127 };
  }

  let shellTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    shellTimeoutHandle = setTimeout(() => reject(new Error("Shell job timed out after 300s")), 300_000);
  });

  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    [stdout, stderr] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
      timeoutPromise,
    ]) as [string, string];
    await proc.exited;
    exitCode = proc.exitCode ?? 1;
  } catch (err) {
    try { proc.kill("SIGTERM"); } catch {}
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 124;
  } finally {
    clearTimeout(shellTimeoutHandle);
  }

  // A clean, silent run (exit 0, nothing printed) means the job had nothing
  // to report — skip the log file so silent no-ops don't pile up between
  // real events. Errors and any output always get a log entry.
  if (exitCode === 0 && !stdout.trim() && !stderr.trim()) {
    console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} (silent, no log)`);
    return { stdout, stderr, exitCode };
  }

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Mode: shell (no Claude session)`,
    `Script: ${script.split("\n")[0]}${script.includes("\n") ? " ..." : ""}`,
    `Exit code: ${exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");
  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  return { stdout, stderr, exitCode };
}

export async function runShell(name: string, prompt: string): Promise<RunResult> {
  return execShell(name, prompt);
}

// --- Quick session: dedicated lightweight session for general-channel Discord messages ---
// Resumed on every message (fast — skips full init), compacted every QUICK_COMPACT_EVERY turns.
const QUICK_SESSION_FILE = join(process.cwd(), ".claude/claudeclaw/quick-session.json");
const QUICK_COMPACT_EVERY = 5;

interface QuickSession { sessionId: string; turnCount: number; createdAt: string; }

async function getQuickSession(): Promise<QuickSession | null> {
  try { return JSON.parse(await readFile(QUICK_SESSION_FILE, "utf8")); } catch { return null; }
}

async function saveQuickSession(s: QuickSession): Promise<void> {
  await writeFile(QUICK_SESSION_FILE, JSON.stringify(s, null, 2), "utf8");
}

async function deleteQuickSession(): Promise<void> {
  try { await unlink(QUICK_SESSION_FILE); } catch {}
}

/**
 * Run using a persistent but aggressively-compacted quick session.
 * Resuming an existing session is fast (skips full Claude Code init).
 * Compact every QUICK_COMPACT_EVERY turns to keep context lean.
 * Serialized on its own queue: concurrent callers would otherwise --resume
 * the same session at once and race the turnCount/compact bookkeeping.
 */
export async function runOnce(name: string, prompt: string): Promise<RunResult> {
  return enqueue(() => execQuick(name, prompt), "quick-session");
}

async function execQuick(name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });
  const settings = getSettings();
  const { security, api } = settings;
  const securityArgs = buildSecurityArgs(security);
  const timeoutMs = settings.sessionTimeoutMs ?? CLAUDE_TIMEOUT_MS;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);
  const model = "claude-sonnet-4-6";

  const existing = await getQuickSession();
  const isNew = !existing;
  const outputFormat = isNew ? "json" : "text";
  const args = [...CLAUDE_CMD, "-p", prompt, "--output-format", outputFormat, "--model", model, ...securityArgs];
  if (!isNew) args.push("--resume", existing.sessionId);

  const baseEnv = buildCleanEnv();

  console.log(`[${new Date().toLocaleTimeString()}] Running: ${name} (quick/${isNew ? "new" : `resume ${existing.sessionId.slice(0, 8)}`})`);
  const exec = await runClaudeOnce(args, model, api, baseEnv, timeoutMs);

  let stdout = exec.rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";

  if (isNew && exec.exitCode === 0) {
    try {
      const json = JSON.parse(exec.rawStdout);
      sessionId = json.session_id;
      stdout = json.result ?? "";
      await saveQuickSession({ sessionId, turnCount: 1, createdAt: new Date().toISOString() });
      console.log(`[${new Date().toLocaleTimeString()}] Quick session created: ${sessionId}`);
    } catch {}
  } else if (!isNew && exec.exitCode === 0) {
    const turnCount = existing.turnCount + 1;
    await saveQuickSession({ ...existing, turnCount });
    if (turnCount % QUICK_COMPACT_EVERY === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Quick session compact (turn ${turnCount})`);
      await runCompact(sessionId, model, api, baseEnv, securityArgs, timeoutMs);
    }
  } else if (exec.exitCode !== 0) {
    // Session may be corrupt — delete so next message gets a fresh one
    await deleteQuickSession();
  }

  const result: RunResult = { stdout, stderr: exec.stderr, exitCode: exec.exitCode };
  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (quick/${isNew ? "new" : "resumed"})`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    result.stdout,
    ...(result.stderr ? ["## Stderr", result.stderr] : []),
  ].join("\n");
  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);
  return result;
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

  // stream-json gives us events as they happen — text before tool calls,
  // so we can unblock the UI as soon as Claude acknowledges, not after sub-agents finish.
  // --verbose is required for stream-json to produce output in -p (print) mode.
  const args = [...CLAUDE_CMD, "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

  if (existing) args.push("--resume", existing.sessionId);

  // CLAUDE.md auto-loaded; no manual loading needed.
  const appendParts: string[] = [];
  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

  // Write system prompt to a temp file to avoid Windows cmd.exe 8191-char command-line limit.
  const streamSyspromptFile = nextSyspromptFile();
  if (appendParts.length > 0) {
    await writeFile(streamSyspromptFile, appendParts.join("\n\n"), "utf8");
    args.push("--append-system-prompt-file", streamSyspromptFile);
  }

  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const childEnv = buildChildEnv(buildCleanEnv(), model, api);

  console.log(`[${new Date().toLocaleTimeString()}] Running: ${name} (stream-json, session: ${existing?.sessionId?.slice(0, 8) ?? "new"})`);

  let proc: PipedSubprocess;
  try {
    proc = await spawnWithRetry(args, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: childEnv,
    });
  } catch (err) {
    // Spawn failed after retry — surface it as a chat message and unblock
    // the UI instead of throwing out of this streaming call.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] Spawn failed after retry: ${message}`);
    onChunk(`⚠️ Couldn't start Claude: ${message}`);
    onUnblock();
    if (appendParts.length > 0) unlink(streamSyspromptFile).catch(() => {});
    return;
  }

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
  // Clean up temp system prompt file
  if (appendParts.length > 0) unlink(streamSyspromptFile).catch(() => {});

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

export async function runUserMessage(name: string, prompt: string, threadId?: string): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), threadId);
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
