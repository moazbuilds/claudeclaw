// Shared messaging utilities used by telegram.ts, discord.ts, and start.ts

/**
 * Describe the current provider/model in a human-readable string.
 */
export function describeProvider(result: { providerLabel: string; modelLabel: string; usedFallback: boolean }): string {
  if (!result.usedFallback) return `Primary Claude active (${result.modelLabel}).`;

  if (result.providerLabel === "fallback:openrouter") {
    return `Fallback active: OpenRouter (${result.modelLabel}).`;
  }
  if (result.providerLabel === "fallback:gemini") {
    return `Fallback active: Gemini (${result.modelLabel}).`;
  }
  if (result.providerLabel === "fallback:ollama") {
    return `Fallback active: Ollama (${result.modelLabel}).`;
  }
  return `Fallback active: ${result.providerLabel} (${result.modelLabel}).`;
}

/**
 * Extract an error detail string from a run result, preferring stderr,
 * then trying to parse JSON stdout for error fields emitted by Claude CLI.
 *
 * Claude CLI exits non-zero on auth and quota failures, but the human-readable
 * message ("Not logged in · Please run /login") lives in the JSON stdout
 * `result` field, not stderr. This function extracts it so chat bridges show
 * the real error instead of "Unknown error".
 */
export function extractErrorDetail(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr?.trim() || "";
  if (stderr) return stderr;

  const stdout = result.stdout?.trim() || "";
  if (!stdout) return "";

  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.is_error && parsed?.result) return String(parsed.result).trim();
    if (parsed?.error?.message) return String(parsed.error.message).trim();
    if (typeof parsed?.error === "string") return parsed.error.trim();
  } catch {}

  return stdout;
}

/**
 * Check if user text is asking about which model/provider is active.
 */
export function isProviderStatusQuery(text: string): boolean {
  return /(what model|which model|what provider|which provider|running on|active model|active provider|are you on|using openrouter|using ollama|using gemini|using opus|change\s+(?:to|model)|switch\s+(?:to|model)|use\s+(?:opus|sonnet|haiku|gemini|ollama|claude))/i.test(text);
}

/**
 * Check if user text is requesting a model change (not just asking about it).
 */
export function isModelChangeRequest(text: string): boolean {
  return /\b(change\s+(?:to|model)|switch\s+(?:to|model)|use\s+(?:opus|sonnet|haiku|gemini|ollama|claude)|(?:opus|sonnet|haiku)\s+(?:mode|model|please))\b/i.test(text);
}

/**
 * Build an authoritative reply about the current provider status.
 */
export function authoritativeProviderReply(text: string, result: { providerLabel: string; modelLabel: string; usedFallback: boolean }): string {
  const isChangeReq = isModelChangeRequest(text);
  const suffix = isChangeReq
    ? " To change models, edit settings.json or use /config in Dispatch."
    : "";

  if (!result.usedFallback) {
    return `Primary Claude is active right now (${result.modelLabel}).${suffix}`;
  }

  if (result.providerLabel === "fallback:openrouter") {
    return `Claude is not active right now. Current provider is OpenRouter (${result.modelLabel}).${suffix}`;
  }
  if (result.providerLabel === "fallback:gemini") {
    return `Claude is not active right now. Current provider is Gemini (${result.modelLabel}).${suffix}`;
  }
  if (result.providerLabel === "fallback:ollama") {
    return `Claude is not active right now. Current provider is Ollama (${result.modelLabel}).${suffix}`;
  }
  return `Current provider is ${result.providerLabel} (${result.modelLabel}).${suffix}`;
}

/**
 * Extract a [react:emoji] directive from response text, returning
 * the cleaned text and the first reaction emoji found (if any).
 */
export function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}
