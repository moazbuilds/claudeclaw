/**
 * Memory Persistence
 *
 * Loads and manages MEMORY.md files for the main session and agent sessions.
 * Memory is injected into --append-system-prompt on every invocation.
 */

import { join } from "path";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";

const PROJECT_DIR = process.cwd();
const CLAUDECLAW_DIR = join(PROJECT_DIR, ".claude", "claudeclaw");
// MEMORY.md lives in project root (NOT .claude/) because Claude Code
// blocks writes to .claude/ directories even with --dangerously-skip-permissions
const MEMORY_FILE = join(PROJECT_DIR, "MEMORY.md");
const AGENTS_DIR = join(CLAUDECLAW_DIR, "agents");

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const MEMORY_INSTRUCTIONS_FILE = join(PROMPTS_DIR, "MEMORY_INSTRUCTIONS.md");

const MEMORY_TEMPLATE = [
  "# Memory",
  "",
  "## Current Status",
  "- No tasks in progress",
  "",
  "## Key Decisions",
  "- None yet",
  "",
  "## Session Log",
  "- Session started",
  "",
].join("\n");

// Agent memory also lives outside .claude/ for the same write permission reason
const AGENTS_MEMORY_DIR = join(PROJECT_DIR, "agents");

export function getMemoryPath(agentName?: string): string {
  if (agentName) {
    return join(AGENTS_MEMORY_DIR, agentName, "MEMORY.md");
  }
  return MEMORY_FILE;
}

export async function ensureMemoryFile(agentName?: string): Promise<void> {
  const memPath = getMemoryPath(agentName);
  const dir = join(memPath, "..");
  await mkdir(dir, { recursive: true });
  if (!existsSync(memPath)) {
    await writeFile(memPath, MEMORY_TEMPLATE, "utf8");
  }
}

export async function loadMemory(agentName?: string): Promise<string> {
  const memPath = getMemoryPath(agentName);
  try {
    if (!existsSync(memPath)) return "";
    const content = await readFile(memPath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

export async function loadMemoryInstructions(agentName?: string): Promise<string> {
  try {
    if (!existsSync(MEMORY_INSTRUCTIONS_FILE)) return "";
    const content = await readFile(MEMORY_INSTRUCTIONS_FILE, "utf8");
    if (!content.trim()) return "";
    return content.trim().replace(/<MEMORY_PATH>/g, getMemoryPath(agentName));
  } catch {
    return "";
  }
}
