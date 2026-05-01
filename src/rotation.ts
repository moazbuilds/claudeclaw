import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { peekSession, backupSession, resetSession } from "./sessions";
import type { GlobalSession } from "./sessions";

const SUMMARY_TIMEOUT_MS = 60_000;
import type { SessionConfig } from "./config";

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const SUMMARY_PROMPT_FILE = join(PROMPTS_DIR, "SUMMARY.md");

// Env vars injected by a parent Claude Code session that break detached child auth.
// Mirror of the stripping done in runner.ts cleanSpawnEnv().
const STRIPPED_ENV_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
]);

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV_KEYS.has(key)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function needsRotation(session: GlobalSession, config: SessionConfig): boolean {
  if (!config.autoRotate) return false;
  if ((session.messageCount ?? 0) >= config.maxMessages) return true;
  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  if (ageMs >= config.maxAgeHours * 3_600_000) return true;
  return false;
}

export async function rotateSession(config: SessionConfig): Promise<void> {
  const session = await peekSession();
  if (!session) return;

  const ageH = Math.round((Date.now() - new Date(session.createdAt).getTime()) / 3_600_000);
  console.log(
    `[${new Date().toLocaleTimeString()}] Rotating session ${session.sessionId.slice(0, 8)} (messages: ${session.messageCount ?? 0}, age: ${ageH}h)`
  );

  if (config.summaryPath) {
    try {
      await generateSummary(session.sessionId, config.summaryPath);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to generate session summary:`, e);
    }
  }

  const backupName = await backupSession();
  if (backupName) {
    console.log(`[${new Date().toLocaleTimeString()}] Session backed up as ${backupName}`);
  }

  await resetSession();
  console.log(`[${new Date().toLocaleTimeString()}] Session rotated — next message will create a new session`);
}

async function generateSummary(sessionId: string, summaryPath: string): Promise<void> {
  await mkdir(summaryPath, { recursive: true });

  let summaryPrompt: string;
  try {
    summaryPrompt = await Bun.file(SUMMARY_PROMPT_FILE).text();
  } catch {
    summaryPrompt = "Generate a brief session summary in markdown. Include: key decisions, unfinished tasks, important context for the next session. Max 500 words.";
  }

  const proc = Bun.spawn(
    ["claude", "-p", summaryPrompt, "--resume", sessionId, "--output-format", "text"],
    { stdout: "pipe", stderr: "pipe", env: cleanEnv() }
  );

  // Kill the subprocess and skip summary if it takes too long.
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try { proc.kill(); } catch {}
  }, SUMMARY_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  if (killed) {
    console.warn(`[${new Date().toLocaleTimeString()}] Summary generation timed out after ${SUMMARY_TIMEOUT_MS / 1000}s — continuing rotation without summary`);
    return;
  }

  if (proc.exitCode !== 0 || !stdout.trim()) {
    console.error(`[${new Date().toLocaleTimeString()}] Summary generation failed (exit ${proc.exitCode}):`, stderr);
    return;
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.md`;
  const filepath = join(summaryPath, filename);

  await Bun.write(filepath, stdout.trim() + "\n");
  console.log(`[${new Date().toLocaleTimeString()}] Session summary saved: ${filepath}`);
}

export async function loadLatestSummary(summaryPath: string): Promise<string | null> {
  if (!summaryPath || !existsSync(summaryPath)) return null;

  const glob = new Bun.Glob("*.md");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: summaryPath })) {
    files.push(file);
  }
  if (files.length === 0) return null;

  files.sort().reverse();
  try {
    const content = await Bun.file(join(summaryPath, files[0])).text();
    return content.trim() || null;
  } catch {
    return null;
  }
}
