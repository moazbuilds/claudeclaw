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

const REMEMBER_TOKEN = "[remember:";

/** True if `tail` could be the beginning of an unclosed `[remember:` directive. */
function isPartialRememberPrefix(tail: string): boolean {
  const t = tail.toLowerCase();
  if (tail.length <= REMEMBER_TOKEN.length) {
    return REMEMBER_TOKEN.startsWith(t);
  }
  // Already past the token length and still no closing `]` (complete ones are
  // stripped before this check) → it's an in-progress directive, hold it back.
  return t.startsWith(REMEMBER_TOKEN);
}

/**
 * Streaming-safe stripper for `[remember: ...]` directives.
 *
 * Wraps a chunk sink so the directives never reach the user, even when split
 * across chunk boundaries, while collecting the remembered texts. Call
 * `flush()` once the stream ends to emit any trailing text and read the
 * collected memories.
 */
export function createRememberStripper(emit: (text: string) => void): {
  push: (chunk: string) => void;
  flush: () => string[];
} {
  let buffer = "";
  const remembered: string[] = [];

  const drainComplete = () => {
    const pattern = /\[remember:\s*([^\]]+)\]/gi;
    buffer = buffer.replace(pattern, (_m, text: string) => {
      const trimmed = text.trim();
      if (trimmed) remembered.push(trimmed);
      return "";
    });
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      drainComplete();
      // Hold back a tail only if it might be the start of a directive.
      const lastOpen = buffer.lastIndexOf("[");
      if (lastOpen !== -1 && isPartialRememberPrefix(buffer.slice(lastOpen))) {
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
      return remembered;
    },
  };
}
