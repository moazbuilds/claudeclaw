import { join } from "path";
import { unlink, readdir, rename } from "fs/promises";

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

/** Returns the existing session or null. Never creates one. */
export async function getSession(): Promise<{ sessionId: string } | null> {
  const existing = await loadSession();
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
