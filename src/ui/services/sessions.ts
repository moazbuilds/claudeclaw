import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// --- Types ---

export interface SessionInfo {
  id: string;
  agent: string;
  channel: string;
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

// --- JSONL project directory ---

function getProjectDir(): string {
  const cwd = process.cwd().replace(/\//g, "-").replace(/^-/, "-");
  return join(homedir(), ".claude", "projects", cwd);
}

// --- List sessions ---

export async function listSessions(): Promise<SessionInfo[]> {
  const projectDir = getProjectDir();
  const sessionFile = join(process.cwd(), ".claude", "claudeclaw", "session.json");
  const threadFile = join(process.cwd(), ".claude", "claudeclaw", "sessions.json");

  const sessions: SessionInfo[] = [];

  // Read global session
  try {
    if (existsSync(sessionFile)) {
      const data = JSON.parse(await readFile(sessionFile, "utf-8"));
      const messages = await readSessionMessages(data.sessionId, 1, 0);
      const lastMsgs = await readSessionMessages(data.sessionId, 1, -1);
      sessions.push({
        id: data.sessionId,
        agent: "mike",
        channel: "global",
        lastUsedAt: data.lastUsedAt || data.createdAt,
        createdAt: data.createdAt,
        turnCount: data.turnCount || 0,
        firstMessage: messages[0]?.text?.substring(0, 100) || "",
        lastMessage: lastMsgs[0]?.text?.substring(0, 100) || "",
      });
    }
  } catch {}

  // Read thread sessions
  try {
    if (existsSync(threadFile)) {
      const data = JSON.parse(await readFile(threadFile, "utf-8"));
      for (const [threadId, thread] of Object.entries(data.threads || {})) {
        const t = thread as any;
        const channel = threadId.startsWith("slk:") ? "slack" : "whatsapp";
        const messages = await readSessionMessages(t.sessionId, 1, 0);
        const lastMsgs = await readSessionMessages(t.sessionId, 1, -1);
        sessions.push({
          id: t.sessionId,
          agent: "mike",
          channel,
          lastUsedAt: t.lastUsedAt || t.createdAt,
          createdAt: t.createdAt,
          turnCount: t.turnCount || 0,
          firstMessage: messages[0]?.text?.substring(0, 100) || "",
          lastMessage: lastMsgs[0]?.text?.substring(0, 100) || "",
        });
      }
    }
  } catch {}

  // Also scan JSONL files for orphaned sessions
  try {
    const knownIds = new Set(sessions.map((s) => s.id));
    const files = await readdir(projectDir);
    for (const file of files.slice(-20)) { // Last 20 files only
      if (!file.endsWith(".jsonl")) continue;
      const id = basename(file, ".jsonl");
      if (knownIds.has(id)) continue;
      try {
        const fileStat = await stat(join(projectDir, file));
        const messages = await readSessionMessages(id, 1, 0);
        sessions.push({
          id,
          agent: "unknown",
          channel: "unknown",
          lastUsedAt: fileStat.mtime.toISOString(),
          createdAt: fileStat.birthtime.toISOString(),
          turnCount: 0,
          firstMessage: messages[0]?.text?.substring(0, 100) || "",
          lastMessage: "",
        });
      } catch {}
    }
  } catch {}

  // Sort by lastUsedAt descending
  sessions.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  return sessions;
}

// --- Read session messages ---

export async function readSessionMessages(
  sessionId: string,
  limit: number = 10,
  offset: number = 0 // 0 = from start, -1 = last N
): Promise<ChatMessage[]> {
  const projectDir = getProjectDir();
  const filePath = join(projectDir, `${sessionId}.jsonl`);

  if (!existsSync(filePath)) return [];

  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");

  // Parse all user/assistant messages
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        const msg = entry.message;
        let text = "";
        if (msg?.content) {
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
          }
        }
        // Strip ClaudeClaw prefixes (timestamps, channel info, directives)
        text = text.replace(/^\[[\d-]+\s[\d:]+\sUTC[^\]]*\]\n/m, "");
        text = text.replace(/^\[(?:WhatsApp|Slack|Discord)[^\]]*\]\n/m, "");
        text = text.replace(/^## Slack Directives[\s\S]*?(?=\n[A-Z]|\n$)/m, "").trim();
        // Get just the user's actual message
        const lastLine = text.split("\n").pop()?.trim() || text.trim();
        if (lastLine) {
          messages.push({
            role: "user",
            text: lastLine,
            timestamp: entry.timestamp || "",
            uuid: entry.uuid,
          });
        }
      } else if (entry.type === "assistant") {
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          const textParts = content
            .filter((c: any) => c.type === "text" && c.text)
            .map((c: any) => c.text);
          if (textParts.length > 0) {
            messages.push({
              role: "assistant",
              text: textParts.join("\n"),
              timestamp: entry.timestamp || "",
              uuid: entry.uuid,
            });
          }
        }
      }
    } catch {}
  }

  // Apply pagination
  if (offset === -1) {
    // Last N messages
    return messages.slice(-limit);
  }
  return messages.slice(offset, offset + limit);
}

// --- List agents ---

export async function listAgents(): Promise<Array<{ id: string; name: string; description: string }>> {
  const agentsDir = join(process.cwd(), ".claude", "agents");
  const agents: Array<{ id: string; name: string; description: string }> = [];

  // Main agent (Mike)
  agents.push({ id: "mike", name: "Mike", description: "General assistant" });

  try {
    const dirs = await readdir(agentsDir);
    for (const dir of dirs) {
      const agentFile = join(agentsDir, dir, "agent.md");
      if (!existsSync(agentFile)) {
        // Legacy flat file
        const flatFile = join(agentsDir, `${dir}.md`);
        if (existsSync(flatFile)) {
          const content = await readFile(flatFile, "utf-8");
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          agents.push({
            id: dir,
            name: nameMatch?.[1] || dir,
            description: descMatch?.[1]?.substring(0, 80) || "",
          });
        }
        continue;
      }
      const content = await readFile(agentFile, "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (nameMatch) {
        agents.push({
          id: dir,
          name: nameMatch[1],
          description: descMatch?.[1]?.substring(0, 80) || "",
        });
      }
    }
  } catch {}

  return agents;
}
