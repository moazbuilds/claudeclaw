import { mkdir } from "fs/promises";
import { join } from "path";
import { getOrCreateSession } from "./sessions";
import { getSettings, type SecurityConfig } from "./config";

const LOGS_DIR = join(process.cwd(), ".claude/heartbeat/logs");
const SYSTEM_PROMPT_FILE = join(process.cwd(), "prompts", "claudeclaw.md");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Serial queue — prevents concurrent --resume on the same session
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(fn, fn);
  queue = task.catch(() => {});
  return task;
}

const PROJECT_DIR = process.cwd();

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

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

  // Append directory-scoping prompt for all levels except unrestricted
  if (security.level !== "unrestricted") {
    args.push("--append-system-prompt", DIR_SCOPE_PROMPT);
  }

  return args;
}

async function execClaude(name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const { sessionId, isNew } = await getOrCreateSession();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const { security } = getSettings();
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (session: ${sessionId.slice(0, 8)}, ${isNew ? "new" : "resumed"}, security: ${security.level})`
  );

  const args = ["claude", "-p", prompt, "--output-format", "text", ...securityArgs];
  if (isNew) {
    args.push("--session-id", sessionId);
    try {
      const systemPrompt = await Bun.file(SYSTEM_PROMPT_FILE).text();
      if (systemPrompt.trim()) {
        args.push("--system-prompt", systemPrompt.trim());
      }
    } catch {
      // no system prompt file, continue without it
    }
  } else {
    args.push("--resume", sessionId);
  }

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  const result: RunResult = {
    stdout,
    stderr,
    exitCode: proc.exitCode ?? 1,
  };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
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
