import { join } from "path";
import { unlink, readdir, rename, stat } from "fs/promises";
import { homedir } from "os";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

let current: GlobalSession | null = null;

async function loadSession(): Promise<GlobalSession | null> {
  if (current) return current;
  try {
    current = await Bun.file(SESSION_FILE).json();
    return current;
  } catch {
    return null;
  }
}

async function saveSession(session: GlobalSession): Promise<void> {
  current = session;
  await Bun.write(SESSION_FILE, JSON.stringify(session, null, 2) + "\n");
}

/**
 * Encode a filesystem path to Claude Code's project directory name format.
 * Claude Code replaces each path separator '/' with '-'.
 * e.g. /Users/alex/Sites/project → -Users-alex-Sites-project
 */
function encodeProjectPath(dir: string): string {
  return dir.replace(/\//g, "-");
}

/**
 * Find the most recently modified Claude Code session for the current project
 * by scanning ~/.claude/projects/<encoded-path>/ for .jsonl session files.
 */
async function findLatestClaudeCodeSession(): Promise<{ sessionId: string; lastModified: Date } | null> {
  const projectDir = join(homedir(), ".claude", "projects", encodeProjectPath(process.cwd()));

  let files: string[];
  try {
    files = await readdir(projectDir);
  } catch {
    return null;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let latest: { sessionId: string; lastModified: Date } | null = null;

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -6); // strip ".jsonl"
    if (!UUID_RE.test(sessionId)) continue;

    try {
      const { mtime } = await stat(join(projectDir, file));
      if (!latest || mtime > latest.lastModified) {
        latest = { sessionId, lastModified: mtime };
      }
    } catch {
      // ignore unreadable files
    }
  }

  return latest;
}

/** Returns the existing session or null. Never creates one. */
export async function getSession(): Promise<{ sessionId: string } | null> {
  const existing = await loadSession();
  const terminal = await findLatestClaudeCodeSession();

  if (terminal) {
    const existingTime = existing ? new Date(existing.lastUsedAt).getTime() : 0;

    if (terminal.lastModified.getTime() > existingTime) {
      // A more recent terminal session exists — sync to it so all chat windows
      // share the same Claude Code conversation context (issue #39).
      if (!existing || existing.sessionId !== terminal.sessionId) {
        console.log(
          `[${new Date().toLocaleTimeString()}] Session sync: adopting terminal session ${terminal.sessionId.slice(0, 8)}...`
        );
      }
      await saveSession({
        sessionId: terminal.sessionId,
        createdAt: existing?.createdAt ?? terminal.lastModified.toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      return { sessionId: terminal.sessionId };
    }
  }

  if (existing) {
    existing.lastUsedAt = new Date().toISOString();
    await saveSession(existing);
    return { sessionId: existing.sessionId };
  }

  return null;
}

/** Save a session ID obtained from Claude Code's output. */
export async function createSession(sessionId: string): Promise<void> {
  await saveSession({
    sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  });
}

/** Returns session metadata without mutating lastUsedAt. */
export async function peekSession(): Promise<GlobalSession | null> {
  return await loadSession();
}

export async function resetSession(): Promise<void> {
  current = null;
  try {
    await unlink(SESSION_FILE);
  } catch {
    // already gone
  }
}

export async function backupSession(): Promise<string | null> {
  const existing = await loadSession();
  if (!existing) return null;

  // Find next backup index
  let files: string[];
  try {
    files = await readdir(HEARTBEAT_DIR);
  } catch {
    files = [];
  }
  const indices = files
    .filter((f) => /^session_\d+\.backup$/.test(f))
    .map((f) => Number(f.match(/^session_(\d+)\.backup$/)![1]));
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

  const backupName = `session_${nextIndex}.backup`;
  const backupPath = join(HEARTBEAT_DIR, backupName);
  await rename(SESSION_FILE, backupPath);
  current = null;

  return backupName;
}
