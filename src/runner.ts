import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getSession, createSession } from "./sessions";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";

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

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RATE_LIMIT_PATTERN = /you(?:'|’)ve hit your limit/i;

// Serial queue — prevents concurrent --resume on the same session
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(fn, fn);
  queue = task.catch(() => {});
  return task;
}

// Active process tracking — allows kill from outside
let activeProc: ReturnType<typeof Bun.spawn> | null = null;

/** Kill the currently running claude subprocess. Returns true if something was killed. */
export function killActive(): boolean {
  if (!activeProc) return false;
  try { activeProc.kill(); } catch {}
  activeProc = null;
  return true;
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

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  activeProc = proc;
  const [rawStdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (activeProc === proc) activeProc = null;

  return {
    rawStdout,
    stderr,
    exitCode: proc.exitCode ?? 1,
  };
}

const PROJECT_DIR = process.cwd();

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

async function execClaude(name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = await getSession();
  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const { security, model, api, fallback } = getSettings();
  const primaryConfig: ModelConfig = { model, api };
  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // New session: use json output to capture Claude's session_id
  // Resumed session: use text output with --resume
  const outputFormat = isNew ? "json" : "text";
  const args = ["claude", "-p", prompt, "--output-format", outputFormat, ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing.sessionId);
  }

  // Build the appended system prompt: prompt files + directory scoping
  // This is passed on EVERY invocation (not just new sessions) because
  // --append-system-prompt does not persist across --resume.
  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
  ];
  if (promptContent) appendParts.push(promptContent);

  // Load the project's CLAUDE.md if it exists
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  // Strip CLAUDECODE env var so child claude processes don't think they're nested
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv);
    usedFallback = true;
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
      await createSession(sessionId);
      console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
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
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  return result;
}

export async function run(name: string, prompt: string): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt));
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

export async function runUserMessage(name: string, prompt: string): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt));
}

// Path where Claude Code stores session JSONL transcripts for this project
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/root",
  ".claude",
  "projects",
  PROJECT_DIR.replace(/\//g, "-")
);

const FORK_SYSTEM_PROMPT = [
  "You are a FORK AGENT — a lightweight, fast-response watcher running in parallel with the main agent.",
  "",
  "Your job: answer quick questions and peek at the main agent's progress via its session transcript.",
  "",
  "DENY immediately (with a short explanation) any request that would take more than ~30 seconds:",
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

/** Run a fork agent — parallel, does NOT touch the main serial queue or main session. */
export async function runFork(prompt: string): Promise<RunResult> {
  const { model, api } = getSettings();
  const primaryConfig: ModelConfig = { model, api };

  const args = [
    "claude", "-p", prompt,
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--append-system-prompt", FORK_SYSTEM_PROMPT,
  ];
  if (model.trim() && model.trim().toLowerCase() !== "glm") args.push("--model", model.trim());

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  const exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv);

  let stdout = exec.rawStdout;
  if (exec.exitCode === 0) {
    try {
      const json = JSON.parse(exec.rawStdout);
      stdout = json.result ?? exec.rawStdout;
    } catch {}
  }

  return { stdout, stderr: exec.stderr, exitCode: exec.exitCode };
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
