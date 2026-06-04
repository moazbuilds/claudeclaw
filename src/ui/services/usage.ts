import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findSessionJsonlPath } from "../../sessionFiles";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pricing per million tokens (Sonnet 4.6 defaults)
const PRICING = { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 };

export interface SessionUsage {
  sessionId: string;
  label: string;
  channel: "discord" | "web" | "unknown";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  cacheHitPct: number;
  turnCount: number;
  lastUsedAt: string;
}

function calcCost(tokens: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  return (
    tokens.inputTokens * PRICING.input +
    tokens.outputTokens * PRICING.output +
    tokens.cacheReadTokens * PRICING.cacheRead +
    tokens.cacheWriteTokens * PRICING.cacheWrite
  ) / 1_000_000;
}

async function parseJSONLUsage(sessionId: string): Promise<Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">> {
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!UUID_RE.test(sessionId)) return zero;

  const filePath = findSessionJsonlPath(sessionId);
  if (!filePath) return zero;

  const result = { ...zero };
  const seenIds = new Set<string>();
  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") continue;
        const msgId: string | undefined = entry.message?.id;
        if (msgId) {
          if (seenIds.has(msgId)) continue;
          seenIds.add(msgId);
        }
        const u = entry.message?.usage;
        if (!u) continue;
        result.inputTokens += u.input_tokens ?? 0;
        result.outputTokens += u.output_tokens ?? 0;
        result.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        result.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      } catch {}
    }
  } catch {}

  return result;
}

function buildEntry(
  sessionId: string,
  label: string,
  channel: SessionUsage["channel"],
  turnCount: number,
  lastUsedAt: string,
  tokens: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): SessionUsage {
  const totalIn = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  return {
    sessionId,
    label,
    channel,
    ...tokens,
    estimatedCostUsd: calcCost(tokens),
    cacheHitPct: totalIn > 0 ? Math.round((tokens.cacheReadTokens / totalIn) * 100) : 0,
    turnCount,
    lastUsedAt,
  };
}

let usageCache: { data: SessionUsage[]; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getSessionUsage(channelNames?: Record<string, string>): Promise<SessionUsage[]> {
  if (usageCache && Date.now() - usageCache.ts < CACHE_TTL_MS) {
    return usageCache.data;
  }

  const cwd = process.cwd();
  const sessions: SessionUsage[] = [];

  // Global web session
  const sessionFile = join(cwd, ".claude", "claudeclaw", "session.json");
  try {
    if (existsSync(sessionFile)) {
      const data = JSON.parse(await readFile(sessionFile, "utf-8"));
      if (UUID_RE.test(data.sessionId)) {
        const tokens = await parseJSONLUsage(data.sessionId);
        sessions.push(buildEntry(
          data.sessionId, "global", "web",
          data.turnCount ?? 0,
          data.lastUsedAt || data.createdAt,
          tokens,
        ));
      }
    }
  } catch {}

  // Per-channel Discord sessions
  const sessionsFile = join(cwd, ".claude", "claudeclaw", "sessions.json");
  try {
    if (existsSync(sessionsFile)) {
      const data = JSON.parse(await readFile(sessionsFile, "utf-8"));
      for (const [threadId, thread] of Object.entries(data.threads ?? {})) {
        const t = thread as any;
        if (!UUID_RE.test(t.sessionId)) continue;
        const label = channelNames?.[threadId] ?? `#${threadId}`;
        const tokens = await parseJSONLUsage(t.sessionId);
        sessions.push(buildEntry(
          t.sessionId, label, "discord",
          t.turnCount ?? 0,
          t.lastUsedAt || t.createdAt,
          tokens,
        ));
      }
    }
  } catch {}

  sessions.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  usageCache = { data: sessions, ts: Date.now() };
  return sessions;
}

export function invalidateUsageCache(): void {
  usageCache = null;
}
