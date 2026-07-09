/**
 * Local Ollama routing for read-only queries.
 * Responses are tagged with LOCAL_SIGIL so the user knows which model answered.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const OLLAMA_BASE = "http://localhost:11434";
export const LOCAL_SIGIL = "◉";

const CLASSIFIER_PROMPT = (msg: string) => `Classify this message as READ or WRITE. Answer with exactly one word.

READ = looking up info, asking questions, requesting summaries or reports
WRITE = logging, adding, updating, deleting, deploying, creating, changing

Message: "${msg}"

Answer:`;

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

const CONTEXT_MAP: Array<{ pattern: RegExp; file: string }> = [
  { pattern: /whiskey|whisky/i, file: `${HOME}/Dev/whiskey-dashboard/public/whiskeys.json` },
  { pattern: /beer/i, file: `${HOME}/Dev/beer-dashboard/public/beers.json` },
  { pattern: /todo|task/i, file: `${HOME}/Dev/todos-dashboard/public/tasks.json` },
  { pattern: /birthday/i, file: `${HOME}/Dev/birthday-tracker/src/data/birthdays.json` },
  { pattern: /banjo|song/i, file: `${HOME}/Dev/banjo-dashboard/songs.json` },
];

function safeRead(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

function gatherContextFiles(prompt: string): string[] {
  return CONTEXT_MAP
    .filter(({ pattern }) => pattern.test(prompt))
    .map(({ file }) => file)
    .filter(existsSync);
}

function buildDataContext(files: string[]): string {
  return files
    .map(f => { try { return `[${f}]\n${readFileSync(f, "utf8")}`; } catch { return ""; } })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build the system prompt for Ollama: SOUL.md + CLAUDE.md.
 * SOUL.md provides the persona/vibe; CLAUDE.md has Adam's full context.
 */
function buildSystemPrompt(): string {
  const parts: string[] = [];

  const soul = safeRead(join(PROMPTS_DIR, "SOUL.md"));
  if (soul) parts.push(soul);

  // Project CLAUDE.md has the richest context (workspace, apps, key facts)
  const claudeMd = safeRead(join(process.cwd(), "CLAUDE.md"));
  if (claudeMd) parts.push(claudeMd);

  return parts.join("\n\n---\n\n");
}

/** Returns true if Ollama is reachable. */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Classifies a prompt as read-only or write. Throws if Ollama is unreachable. */
export async function classifyReadOnly(prompt: string, classifierModel: string): Promise<boolean> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model: classifierModel, prompt: CLASSIFIER_PROMPT(prompt), stream: false }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Ollama classify failed: ${res.status}`);
  const { response } = await res.json() as { response: string };
  return response.trim().toUpperCase().startsWith("READ");
}

/**
 * Run a read-only query through a local Ollama model.
 * Injects SOUL.md + CLAUDE.md as system prompt, data files as context.
 * Appends LOCAL_SIGIL to the response.
 * Throws if Ollama is unreachable or returns an error.
 */
export async function queryOllama(prompt: string, readerModel: string): Promise<string> {
  const files = gatherContextFiles(prompt);
  const dataContext = buildDataContext(files);
  const system = buildSystemPrompt();

  const userPrompt = dataContext
    ? `Here is the relevant data:\n\n${dataContext}\n\nUser query: ${prompt}\n\nAnswer concisely:`
    : prompt;

  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model: readerModel, system, prompt: userPrompt, stream: false }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ollama query failed: ${res.status}`);
  const { response } = await res.json() as { response: string };
  return `${response.trim()} ${LOCAL_SIGIL}`;
}
