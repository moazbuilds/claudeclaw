import { join } from "path";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SESSIONS_FILE = join(HEARTBEAT_DIR, "sessions.json");

export interface ThreadSession {
  sessionId: string;
  threadId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
}

interface SessionsData {
  threads: Record<string, ThreadSession>;
}

let sessionsCache: SessionsData | null = null;

async function loadSessions(): Promise<SessionsData> {
  if (sessionsCache) return sessionsCache;
  try {
    sessionsCache = await Bun.file(SESSIONS_FILE).json();
    return sessionsCache!;
  } catch {
    sessionsCache = { threads: {} };
    return sessionsCache;
  }
}

async function saveSessions(data: SessionsData): Promise<void> {
  sessionsCache = data;
  await Bun.write(SESSIONS_FILE, JSON.stringify(data, null, 2) + "\n");
}

/** Get session for a thread. Returns null if no session exists yet. */
export async function getThreadSession(
  threadId: string,
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return null;

  if (typeof session.turnCount !== "number") session.turnCount = 0;
  if (typeof session.compactWarned !== "boolean") session.compactWarned = false;

  session.lastUsedAt = new Date().toISOString();
  await saveSessions(data);

  return {
    sessionId: session.sessionId,
    turnCount: session.turnCount,
    compactWarned: session.compactWarned,
  };
}

/** Create a new thread session after Claude outputs a session_id. */
export async function createThreadSession(threadId: string, sessionId: string): Promise<void> {
  const data = await loadSessions();
  data.threads[threadId] = {
    sessionId,
    threadId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  };
  await saveSessions(data);
}

/** Remove a thread session (e.g., on thread delete/archive). */
export async function removeThreadSession(threadId: string): Promise<void> {
  const data = await loadSessions();
  if (!data.threads[threadId]) return;
  delete data.threads[threadId];
  await saveSessions(data);
}

/** Increment turn counter for a thread session. */
export async function incrementThreadTurn(threadId: string): Promise<number> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return 0;
  if (typeof session.turnCount !== "number") session.turnCount = 0;
  session.turnCount += 1;
  await saveSessions(data);
  return session.turnCount;
}

/** Mark compact warning sent for a thread session. */
export async function markThreadCompactWarned(threadId: string): Promise<void> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return;
  session.compactWarned = true;
  await saveSessions(data);
}

/** List all active thread sessions. */
export async function listThreadSessions(): Promise<ThreadSession[]> {
  const data = await loadSessions();
  return Object.values(data.threads);
}

/** Peek at a thread session without updating lastUsedAt. */
export async function peekThreadSession(threadId: string): Promise<ThreadSession | null> {
  const data = await loadSessions();
  return data.threads[threadId] ?? null;
}
