/**
 * Install Module
 *
 * Wires ClaudeClaw's skills and slash commands into Claude Code's user-level
 * discovery paths (`~/.claude/skills/*` and `~/.claude/commands/claudeclaw/`).
 *
 * Claude Code's skill/command loader searches `~/.claude/skills/` and
 * `~/.claude/commands/`. On deployed installs the source tree lives elsewhere
 * (e.g. `/opt/claudeclaw/`) and isn't seen by Claude Code unless explicitly
 * symlinked into the user dir. This module creates those symlinks on daemon
 * startup so every fresh deploy "just works" without manual shell setup.
 *
 * Idempotent: skips any target path that already exists (file, dir, or symlink).
 * Non-destructive: never replaces existing entries — user-created skills/commands
 * in `~/.claude/` are preserved.
 *
 * Local dev (running the daemon from the repo root) is a no-op: skill files are
 * already in the repo's `./skills/` and `./commands/`, which Claude Code finds
 * via its project-level search. Only runs in "deployed mode" where
 * `CLAUDECLAW_ROOT` is set AND points somewhere outside the current cwd.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, lstatSync } from "fs";
import { mkdir, readdir, symlink } from "fs/promises";

interface LinkResult {
  created: string[];
  skipped: string[];
  errors: { path: string; reason: string }[];
}

export interface EnsureSymlinksOpts {
  /** Override the user home directory. Defaults to os.homedir(). Injected by tests. */
  homeDir?: string;
  /** Override the claudeclaw install root. Defaults to process.env.CLAUDECLAW_ROOT. */
  claudeclawRoot?: string;
}

/**
 * Ensure `~/.claude/skills/<name>` and `~/.claude/commands/claudeclaw` symlinks
 * point at the ClaudeClaw install directory's skills and commands.
 *
 * Only runs in deployed mode. Detects deployed mode by checking whether
 * `CLAUDECLAW_ROOT` is set AND different from `process.cwd()`.
 *
 * @returns Summary of created/skipped/errored links. Errors are non-fatal —
 *          the daemon logs them but keeps starting.
 */
export async function ensureUserSymlinks(opts: EnsureSymlinksOpts = {}): Promise<LinkResult> {
  const result: LinkResult = { created: [], skipped: [], errors: [] };

  const claudeclawRoot = opts.claudeclawRoot ?? process.env.CLAUDECLAW_ROOT;
  if (!claudeclawRoot) return result; // local dev — nothing to link
  if (claudeclawRoot === process.cwd()) return result; // dev running from repo root

  const home = opts.homeDir ?? homedir();
  const skillsSrc = join(claudeclawRoot, "skills");
  const commandsSrc = join(claudeclawRoot, "commands", "claudeclaw");
  const userSkillsDir = join(home, ".claude", "skills");
  const userCommandsDir = join(home, ".claude", "commands");

  // Skills: one symlink per entry under <root>/skills/
  if (existsSync(skillsSrc)) {
    try {
      await mkdir(userSkillsDir, { recursive: true });
      const entries = await readdir(skillsSrc, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const target = join(skillsSrc, entry.name);
        const linkPath = join(userSkillsDir, entry.name);
        if (pathExistsAny(linkPath)) {
          result.skipped.push(linkPath);
          continue;
        }
        try {
          await symlink(target, linkPath, "dir");
          result.created.push(linkPath);
        } catch (err) {
          result.errors.push({ path: linkPath, reason: (err as Error).message });
        }
      }
    } catch (err) {
      result.errors.push({ path: userSkillsDir, reason: (err as Error).message });
    }
  }

  // Slash commands: single symlink for the whole claudeclaw/ subdirectory
  if (existsSync(commandsSrc)) {
    try {
      await mkdir(userCommandsDir, { recursive: true });
      const linkPath = join(userCommandsDir, "claudeclaw");
      if (pathExistsAny(linkPath)) {
        result.skipped.push(linkPath);
      } else {
        await symlink(commandsSrc, linkPath, "dir");
        result.created.push(linkPath);
      }
    } catch (err) {
      result.errors.push({
        path: join(userCommandsDir, "claudeclaw"),
        reason: (err as Error).message,
      });
    }
  }

  return result;
}

/**
 * existsSync returns false for broken symlinks (stat follows the link).
 * We want to treat any existing entry at the path — including broken links —
 * as "something is there, don't touch it". lstatSync does not follow links.
 */
function pathExistsAny(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
