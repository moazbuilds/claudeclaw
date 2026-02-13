import { join } from "path";
import { unlink, readdir, rename } from "fs/promises";
import { randomUUID } from "crypto";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "heartbeat");
const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");

interface GlobalSession {
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

export async function getOrCreateSession(): Promise<{ sessionId: string; isNew: boolean }> {
  const existing = await loadSession();
  if (existing) {
    existing.lastUsedAt = new Date().toISOString();
    await saveSession(existing);
    return { sessionId: existing.sessionId, isNew: false };
  }

  const session: GlobalSession = {
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  await saveSession(session);
  return { sessionId: session.sessionId, isNew: true };
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
