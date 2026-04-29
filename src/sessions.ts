import { join } from "path";
import { unlink, readdir, rename } from "fs/promises";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
}

let current: GlobalSession | null = null;

/** Resolve the directory and session-file path for an optional agent. */
function sessionDirFor(agentName?: string): string {
  if (agentName) return join(process.cwd(), "agents", agentName);
  return HEARTBEAT_DIR;
}

function sessionPathFor(agentName?: string): string {
  if (agentName) return join(sessionDirFor(agentName), "session.json");
  return SESSION_FILE;
}

async function loadSession(agentName?: string): Promise<GlobalSession | null> {
  // Agent sessions bypass the module-level cache (cache is global-only).
  if (agentName) {
    try {
      return await Bun.file(sessionPathFor(agentName)).json();
    } catch {
      return null;
    }
  }
  if (current) return current;
  try {
    current = await Bun.file(SESSION_FILE).json();
    return current;
  } catch {
    return null;
  }
}

async function saveSession(session: GlobalSession, agentName?: string): Promise<void> {
  if (!agentName) current = session;
  await Bun.write(sessionPathFor(agentName), JSON.stringify(session, null, 2) + "\n");
}

/** Returns the existing session or null. Never creates one. */
export async function getSession(
  agentName?: string
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const existing = await loadSession(agentName);
  if (existing && existing.sessionId) {
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    if (typeof existing.compactWarned !== "boolean") existing.compactWarned = false;
    existing.lastUsedAt = new Date().toISOString();
    await saveSession(existing, agentName);
    return { sessionId: existing.sessionId, turnCount: existing.turnCount, compactWarned: existing.compactWarned };
  }
  return null;
}

/** Save a session ID obtained from Claude Code's output. */
export async function createSession(sessionId: string, agentName?: string): Promise<void> {
  await saveSession({
    sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  }, agentName);
}

/** Returns session metadata without mutating lastUsedAt. */
export async function peekSession(agentName?: string): Promise<GlobalSession | null> {
  return await loadSession(agentName);
}

/** Increment the turn counter after a successful Claude invocation. */
export async function incrementTurn(agentName?: string): Promise<number> {
  const existing = await loadSession(agentName);
  if (!existing) return 0;
  if (typeof existing.turnCount !== "number") existing.turnCount = 0;
  existing.turnCount += 1;
  await saveSession(existing, agentName);
  return existing.turnCount;
}

/** Mark that the compact warning has been sent for the current session. */
export async function markCompactWarned(agentName?: string): Promise<void> {
  const existing = await loadSession(agentName);
  if (!existing) return;
  existing.compactWarned = true;
  await saveSession(existing, agentName);
}

export async function resetSession(agentName?: string): Promise<void> {
  if (!agentName) current = null;
  try {
    await unlink(sessionPathFor(agentName));
  } catch {
    // already gone
  }
}

export async function backupSession(agentName?: string): Promise<string | null> {
  const existing = await loadSession(agentName);
  if (!existing) return null;

  const dir = sessionDirFor(agentName);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  const indices = files
    .filter((f) => /^session_\d+\.backup$/.test(f))
    .map((f) => Number(f.match(/^session_(\d+)\.backup$/)![1]));
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

  const backupName = `session_${nextIndex}.backup`;
  const backupPath = join(dir, backupName);
  await rename(sessionPathFor(agentName), backupPath);
  if (!agentName) current = null;

  return backupName;
}
