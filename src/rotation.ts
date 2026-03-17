import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { peekSession, backupSession, resetSession } from "./sessions";
import type { GlobalSession } from "./sessions";
import type { SessionConfig } from "./config";

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const SUMMARY_PROMPT_FILE = join(PROMPTS_DIR, "SUMMARY.md");

export function needsRotation(session: GlobalSession, sessionConfig: SessionConfig): boolean {
  if (!sessionConfig.autoRotate) return false;

  if (session.messageCount >= sessionConfig.maxMessages) return true;

  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  if (ageMs >= sessionConfig.maxAgeHours * 3600000) return true;

  return false;
}

export async function rotateSession(sessionConfig: SessionConfig): Promise<void> {
  const session = await peekSession();
  if (!session) return;

  console.log(
    `[${new Date().toLocaleTimeString()}] Rotating session ${session.sessionId.slice(0, 8)} (messages: ${session.messageCount}, age: ${Math.round((Date.now() - new Date(session.createdAt).getTime()) / 3600000)}h)`
  );

  // Generate summary if summaryPath is configured
  if (sessionConfig.summaryPath) {
    try {
      await generateSummary(session.sessionId, sessionConfig.summaryPath);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to generate session summary:`, e);
      // Continue with rotation even if summary fails
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

  const { CLAUDECODE: _, ...cleanEnv } = process.env;

  const proc = Bun.spawn(
    ["claude", "-p", summaryPrompt, "--resume", sessionId, "--output-format", "text"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...cleanEnv } as Record<string, string>,
    }
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

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

  // Sort by filename (date-based) descending, take latest
  files.sort().reverse();
  const latest = join(summaryPath, files[0]);

  try {
    const content = await Bun.file(latest).text();
    return content.trim() || null;
  } catch {
    return null;
  }
}
