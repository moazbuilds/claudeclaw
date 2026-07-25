/**
 * Fallback path for when the Claude CLI itself can't authenticate (expired
 * token, revoked key, billing/login issue) rather than a normal task error.
 * Detected from the CLI's own stdout/stderr text since Claude Code doesn't
 * expose a structured auth-failure exit code.
 */

import { isOllamaAvailable, queryOllama } from "./ollama";

const AUTH_ERROR_PATTERN =
  /invalid[ _-]?api[ _-]?key|invalid x-api-key|unauthorized|401|please run.{0,10}\/login|not authenticated|authentication_error|please log ?in|token has expired|no valid credentials|credit balance is too low/i;

export function isAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERN.test(text);
}

const READER_MODEL = "llama3.2:3b";

export const AUTH_DOWN_MESSAGE =
  "⚡ Claude auth looks down right now (local Ollama isn't reachable either) — I'll stay quiet and keep checking instead of spamming you with raw errors.";

export interface AuthFallbackResult {
  stdout: string;
  usedFallback: "ollama" | "message";
}

/**
 * Called after a Claude CLI invocation fails with an auth error. Tries a
 * local Ollama model so the caller still gets *something* useful; if Ollama
 * isn't reachable either, returns one clean status line instead of the raw
 * CLI error text.
 */
export async function handleAuthFailure(prompt: string, readerModel = READER_MODEL): Promise<AuthFallbackResult> {
  if (await isOllamaAvailable()) {
    try {
      const answer = await queryOllama(prompt, readerModel);
      return { stdout: answer, usedFallback: "ollama" };
    } catch {
      // Ollama was reachable but the query itself failed — fall through to
      // the graceful down-message rather than surfacing that error either.
    }
  }
  return { stdout: AUTH_DOWN_MESSAGE, usedFallback: "message" };
}
