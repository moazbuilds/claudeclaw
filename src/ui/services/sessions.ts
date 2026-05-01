import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { getAgentsDir } from "../../config";

export interface SessionInfo {
  id: string;
  agent: string;
  channel: "web" | "discord" | "agent" | "unknown";
  lastUsedAt: string;
  createdAt: string;
  turnCount: number;
  firstMessage: string;
  lastMessage: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  uuid?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_RE = /^\d{17,19}$/;

// Must match Claude Code's JSONL directory sanitizer (slashes, backslashes, dots → dashes).
function getProjectDir(): string {
  const sanitized = process.cwd().replace(/[/\\.]/g, "-");
  return join(homedir(), ".claude", "projects", sanitized);
}

function extractUserText(line: string): string {
  if (!line.trim()) return "";
  try {
    const entry = JSON.parse(line);
    if (entry.type !== "user") return "";
    const msg = entry.message;
    let raw = "";
    if (typeof msg?.content === "string") {
      raw = msg.content;
    } else if (Array.isArray(msg?.content)) {
      raw = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text as string)
        .join("\n");
    }
    // Strip ClaudeClaw-injected prefix blocks, keep the user's actual text in full.
    raw = raw
      .replace(/^\[[\d-]+ [\d:]+ UTC[^\]]*\]\n/m, "")
      .replace(/^\[(?:WhatsApp|Slack|Discord)[^\]]*\]\n/m, "")
      .replace(/^## Slack Directives[\s\S]*?(?=\n[A-Z\[]|\n$)/m, "")
      .trim();
    return raw;
  } catch {
    return "";
  }
}

// Single file read to get both the first and last user message (for sidebar preview).
async function peekMessages(sessionId: string): Promise<{ first: string; last: string }> {
  if (!UUID_RE.test(sessionId)) return { first: "", last: "" };
  const filePath = join(getProjectDir(), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return { first: "", last: "" };
  let first = "";
  let last = "";
  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const text = extractUserText(line);
      if (text) {
        if (!first) first = text.substring(0, 100);
        last = text.substring(0, 100);
      }
    }
  } catch {}
  return { first, last };
}

export async function listSessions(): Promise<SessionInfo[]> {
  const cwd = process.cwd();
  const sessionFile = join(cwd, ".claude", "claudeclaw", "session.json");
  const sessionsFile = join(cwd, ".claude", "claudeclaw", "sessions.json");

  const sessions: SessionInfo[] = [];
  const knownIds = new Set<string>();

  // Global web session
  try {
    if (existsSync(sessionFile)) {
      const data = JSON.parse(await readFile(sessionFile, "utf-8"));
      if (UUID_RE.test(data.sessionId)) {
        const { first, last } = await peekMessages(data.sessionId);
        sessions.push({
          id: data.sessionId,
          agent: "global",
          channel: "web",
          lastUsedAt: data.lastUsedAt || data.createdAt,
          createdAt: data.createdAt,
          turnCount: data.turnCount ?? 0,
          firstMessage: first,
          lastMessage: last,
        });
        knownIds.add(data.sessionId);
      }
    }
  } catch {}

  // Per-agent sessions — agents/<name>/session.json
  try {
    const agentsDir = getAgentsDir();
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentSessionFile = join(agentsDir, entry.name, "session.json");
      if (!existsSync(agentSessionFile)) continue;
      try {
        const data = JSON.parse(await readFile(agentSessionFile, "utf-8"));
        if (!UUID_RE.test(data.sessionId) || knownIds.has(data.sessionId)) continue;
        const { first, last } = await peekMessages(data.sessionId);
        sessions.push({
          id: data.sessionId,
          agent: entry.name,
          channel: "agent",
          lastUsedAt: data.lastUsedAt || data.createdAt,
          createdAt: data.createdAt,
          turnCount: data.turnCount ?? 0,
          firstMessage: first,
          lastMessage: last,
        });
        knownIds.add(data.sessionId);
      } catch {}
    }
  } catch {}

  // Thread sessions (Discord snowflakes; skip unrecognised thread ID formats)
  try {
    if (existsSync(sessionsFile)) {
      const data = JSON.parse(await readFile(sessionsFile, "utf-8"));
      for (const [threadId, thread] of Object.entries(data.threads ?? {})) {
        const t = thread as any;
        if (!UUID_RE.test(t.sessionId) || knownIds.has(t.sessionId)) continue;
        if (!DISCORD_SNOWFLAKE_RE.test(threadId)) continue;
        const { first, last } = await peekMessages(t.sessionId);
        sessions.push({
          id: t.sessionId,
          agent: "global",
          channel: "discord",
          lastUsedAt: t.lastUsedAt || t.createdAt,
          createdAt: t.createdAt,
          turnCount: t.turnCount ?? 0,
          firstMessage: first,
          lastMessage: last,
        });
        knownIds.add(t.sessionId);
      }
    }
  } catch {}

  // Orphan JSONL sessions not tracked by any session file (up to 20 most recent)
  try {
    const projectDir = getProjectDir();
    const files = (await readdir(projectDir)).filter(f => f.endsWith(".jsonl"));
    const candidates = files
      .map(f => basename(f, ".jsonl"))
      .filter(id => UUID_RE.test(id) && !knownIds.has(id))
      .slice(-20);
    for (const id of candidates) {
      try {
        const fileStat = await stat(join(projectDir, `${id}.jsonl`));
        const { first, last } = await peekMessages(id);
        sessions.push({
          id,
          agent: "unknown",
          channel: "unknown",
          lastUsedAt: fileStat.mtime.toISOString(),
          createdAt: fileStat.birthtime.toISOString(),
          turnCount: 0,
          firstMessage: first,
          lastMessage: last,
        });
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  return sessions;
}

export interface MessagesResult {
  messages: ChatMessage[];
  total: number;
}

export async function readSessionMessages(
  sessionId: string,
  limit = 10,
  offset = 0,
): Promise<MessagesResult> {
  // Validate UUID shape before constructing file path (prevent path traversal).
  if (!UUID_RE.test(sessionId)) return { messages: [], total: 0 };

  const filePath = join(getProjectDir(), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return { messages: [], total: 0 };

  const content = await readFile(filePath, "utf-8");
  const all: ChatMessage[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        const text = extractUserText(line);
        if (text) {
          all.push({ role: "user", text, timestamp: entry.timestamp ?? "", uuid: entry.uuid });
        }
      } else if (entry.type === "assistant") {
        const parts = (entry.message?.content ?? [])
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text as string);
        if (parts.length > 0) {
          all.push({
            role: "assistant",
            text: parts.join("\n"),
            timestamp: entry.timestamp ?? "",
            uuid: entry.uuid,
          });
        }
      }
    } catch {}
  }

  const total = all.length;
  const messages = offset === -1 ? all.slice(-limit) : all.slice(offset, offset + limit);
  return { messages, total };
}

export async function listAgents(): Promise<Array<{ id: string; name: string }>> {
  const agentsDir = getAgentsDir();
  const agents: Array<{ id: string; name: string }> = [{ id: "mike", name: "mike" }];
  const seen = new Set<string>(["mike"]);

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      agents.push({ id: entry.name, name: entry.name });
    }
  } catch {}

  return agents;
}
