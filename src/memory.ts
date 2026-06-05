/**
 * Claw Memory client — semantic memory layer.
 *
 * Talks to the local FastAPI service in services/claw-memory.
 * Per-user collections (isolated by user_id).
 *
 * Endpoint defaults to http://127.0.0.1:8101. Override with CLAW_MEMORY_URL.
 */

const BASE = process.env.CLAW_MEMORY_URL || "http://127.0.0.1:8101";
const TIMEOUT_MS = 5_000;

export interface MemoryHit {
  memory_id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

async function call<T>(path: string, body?: unknown, method = "POST"): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[memory] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[memory] ${path} failed:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function searchMemories(
  userId: string,
  query: string,
  k = 5,
): Promise<MemoryHit[]> {
  const res = await call<{ ok: boolean; results: MemoryHit[] }>(
    "/memories/search",
    { user_id: userId, query, k },
  );
  return res?.results ?? [];
}

export async function addMemory(
  userId: string,
  memoryId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const res = await call<{ ok: boolean }>("/memories/add", {
    user_id: userId,
    memory_id: memoryId,
    text,
    metadata,
  });
  return !!res?.ok;
}

export async function removeMemory(userId: string, memoryId: string): Promise<boolean> {
  const res = await call<{ ok: boolean }>("/memories/remove", {
    user_id: userId,
    memory_id: memoryId,
  });
  return !!res?.ok;
}

export async function memoryHealthy(): Promise<boolean> {
  const res = await call<{ ok: boolean }>("/health", undefined, "GET");
  return !!res?.ok;
}

export interface MemoryEntry {
  memory_id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export async function listMemories(userId: string): Promise<MemoryEntry[]> {
  const res = await call<{ ok: boolean; memories: MemoryEntry[] }>(
    `/memories/list/${encodeURIComponent(userId)}`,
    undefined,
    "GET",
  );
  return res?.memories ?? [];
}

/**
 * Format hits as a prompt block to be injected before the user's heartbeat prompt.
 * Returns empty string when there are no relevant hits, so the prompt stays clean.
 */
export function formatMemoryBlock(hits: MemoryHit[], minScore = 0.35): string {
  const relevant = hits.filter((h) => h.score >= minScore);
  if (relevant.length === 0) return "";
  const lines = relevant.map((h, i) => `${i + 1}. (${h.score.toFixed(2)}) ${h.text}`);
  return `Relevante gespeicherte Erinnerungen über diese Person:\n${lines.join("\n")}`;
}

/**
 * Extract memory-save directives from a coach reply.
 * Coach can append `[remember: <text>]` blocks to persist new memories.
 * Returns the cleaned reply (directives stripped) and the parsed texts.
 */
export function extractRememberDirectives(reply: string): {
  cleaned: string;
  remembered: string[];
} {
  const pattern = /\[remember:\s*([^\]]+)\]/gi;
  const remembered: string[] = [];
  const cleaned = reply.replace(pattern, (_m, text: string) => {
    const trimmed = text.trim();
    if (trimmed) remembered.push(trimmed);
    return "";
  }).trim();
  return { cleaned, remembered };
}

const DIRECTIVE_TOKENS = ["[remember:", "[forget:"];

/** True if `tail` could be the beginning of an unclosed memory directive. */
function isPartialDirectivePrefix(tail: string): boolean {
  const t = tail.toLowerCase();
  return DIRECTIVE_TOKENS.some((token) =>
    t.length <= token.length ? token.startsWith(t) : t.startsWith(token),
  );
}

export interface StripperResult {
  remembered: string[];
  forgotten: string[];
}

/**
 * Streaming-safe stripper for `[remember: ...]` and `[forget: ...]` directives.
 *
 * Wraps a chunk sink so the directives never reach the user, even when split
 * across chunk boundaries, while collecting the texts. Call `flush()` once the
 * stream ends to emit any trailing text and read the collected directives.
 */
export function createRememberStripper(emit: (text: string) => void): {
  push: (chunk: string) => void;
  flush: () => StripperResult;
} {
  let buffer = "";
  const remembered: string[] = [];
  const forgotten: string[] = [];

  const drainComplete = () => {
    buffer = buffer.replace(/\[remember:\s*([^\]]+)\]/gi, (_m, text: string) => {
      const trimmed = text.trim();
      if (trimmed) remembered.push(trimmed);
      return "";
    });
    buffer = buffer.replace(/\[forget:\s*([^\]]+)\]/gi, (_m, text: string) => {
      const trimmed = text.trim();
      if (trimmed) forgotten.push(trimmed);
      return "";
    });
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      drainComplete();
      // Hold back a tail only if it might be the start of a directive.
      const lastOpen = buffer.lastIndexOf("[");
      if (lastOpen !== -1 && isPartialDirectivePrefix(buffer.slice(lastOpen))) {
        const safe = buffer.slice(0, lastOpen);
        buffer = buffer.slice(lastOpen);
        if (safe) emit(safe);
      } else {
        if (buffer) emit(buffer);
        buffer = "";
      }
    },
    flush() {
      drainComplete();
      if (buffer) {
        emit(buffer);
        buffer = "";
      }
      return { remembered, forgotten };
    },
  };
}

/**
 * Hidden instruction injected into each chat message so any responding session
 * (including a brand-new one) knows the organic memory convention. The user
 * never sees this — it's part of the model input, not the output.
 */
export const MEMORY_DIRECTIVE_HINT =
  "[Memory: Du kannst dir dauerhaft etwas Bleibendes über diese Person merken, " +
  "indem du am Ende deiner Antwort `[remember: kurzer Fakt]` schreibst — wird dem " +
  "Nutzer nicht angezeigt. Nur wirklich Bleibendes (Vorlieben, Ziele, Fakten), " +
  "keine Wegwerf-Details. Etwas vergessen: `[forget: stichwort]`. Sparsam einsetzen.]";
