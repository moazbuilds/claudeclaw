import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SkillInfo {
  name: string;
  description: string;
}

// List all available skills with name + short description.
// Scans project, global, and plugin skill directories.
export async function listSkills(): Promise<SkillInfo[]> {
  const home = homedir();
  const projectSkillsDir = join(process.cwd(), ".claude", "skills");
  const globalSkillsDir = join(home, ".claude", "skills");
  const pluginsDir = join(home, ".claude", "plugins");
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  await collectSkillsFromDir(projectSkillsDir, null, seen, skills);
  await collectSkillsFromDir(globalSkillsDir, null, seen, skills);

  const cachePath = join(pluginsDir, "cache");
  if (existsSync(cachePath)) {
    try {
      const pluginDirs = await readdir(cachePath, { withFileTypes: true });
      for (const pd of pluginDirs) {
        if (!pd.isDirectory()) continue;
        const pluginCacheDir = join(cachePath, pd.name);
        const subDirs = await readdir(pluginCacheDir, { withFileTypes: true }).catch(() => []);
        for (const sub of subDirs) {
          if (!sub.isDirectory()) continue;
          const innerDir = join(pluginCacheDir, sub.name);
          const verDirs = await readdir(innerDir, { withFileTypes: true }).catch(() => []);
          for (const ver of verDirs) {
            if (!ver.isDirectory()) continue;
            await collectSkillsFromDir(join(innerDir, ver.name, "skills"), pd.name, seen, skills);
          }
          await collectSkillsFromDir(join(innerDir, "skills"), pd.name, seen, skills);
        }
      }
    } catch {
      // cache dir not readable
    }
  }

  return skills;
}

async function collectSkillsFromDir(
  dir: string,
  pluginName: string | null,
  seen: Set<string>,
  skills: SkillInfo[],
): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      let content: string;
      try {
        content = await readFile(skillPath, "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;

      const name = pluginName ? `${pluginName}_${entry.name}` : entry.name;
      if (seen.has(name)) continue;
      seen.add(name);

      skills.push({ name, description: extractDescription(content) });
    }
  } catch {
    // dir not readable
  }
}

function extractDescription(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const descMatch = fm.match(/^description:\s*>?\s*\n?([\s\S]*?)(?=\n\w|\n---|\n$)/m);
    if (descMatch) {
      const raw = descMatch[1].replace(/\n\s*/g, " ").trim();
      if (raw) return raw.slice(0, 256);
    }
    const singleMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (singleMatch) return singleMatch[1].trim().slice(0, 256);
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed.slice(0, 256);
  }
  return "Claude Code skill";
}

// Resolve a slash command name to a Claude Code skill prompt.
// Search order:
// 1. Project skills: {cwd}/.claude/skills/{name}/SKILL.md
// 2. Global skills: ~/.claude/skills/{name}/SKILL.md
// 3. Plugin skills: ~/.claude/plugins/*/skills/{name}/SKILL.md
// Returns the SKILL.md content if found, or null.
export async function resolveSkillPrompt(command: string): Promise<string | null> {
  // Strip leading "/" if present
  const name = command.startsWith("/") ? command.slice(1) : command;
  if (!name) return null;

  // Handle "plugin:skill" format
  const colonIdx = name.indexOf(":");
  const pluginHint = colonIdx > 0 ? name.slice(0, colonIdx) : null;
  const skillName = colonIdx > 0 ? name.slice(colonIdx + 1) : name;

  const home = homedir();
  const projectSkillsDir = join(process.cwd(), ".claude", "skills");
  const globalSkillsDir = join(home, ".claude", "skills");
  const pluginsDir = join(home, ".claude", "plugins");

  // 1. Project-level skills (exact name match)
  if (!pluginHint) {
    const projectPath = join(projectSkillsDir, skillName, "SKILL.md");
    const content = await tryReadFile(projectPath);
    if (content) return content;
  }

  // 2. Global skills (exact name match)
  if (!pluginHint) {
    const globalPath = join(globalSkillsDir, skillName, "SKILL.md");
    const content = await tryReadFile(globalPath);
    if (content) return content;
  }

  // 3. Plugin skills
  const pluginContent = await searchPluginSkills(pluginsDir, skillName, pluginHint);
  if (pluginContent) return pluginContent;

  return null;
}

async function tryReadFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function searchPluginSkills(
  pluginsDir: string,
  skillName: string,
  pluginHint: string | null,
): Promise<string | null> {
  if (!existsSync(pluginsDir)) return null;

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // If pluginHint is given, only check that specific plugin
      if (pluginHint && entry.name !== pluginHint) continue;

      const skillPath = join(pluginsDir, entry.name, "skills", skillName, "SKILL.md");
      const content = await tryReadFile(skillPath);
      if (content) return content;

      // Also check cache dir structure: plugins/cache/{plugin}/{plugin}/{version}/skills/{name}/SKILL.md
      const cachePath = join(pluginsDir, "cache", entry.name);
      if (existsSync(cachePath)) {
        const cacheContent = await searchCacheDir(cachePath, skillName);
        if (cacheContent) return cacheContent;
      }
    }

    // Direct cache search when no plugin dirs matched
    if (!pluginHint) {
      const cachePath = join(pluginsDir, "cache");
      if (existsSync(cachePath)) {
        const cacheEntries = await readdir(cachePath, { withFileTypes: true });
        for (const ce of cacheEntries) {
          if (!ce.isDirectory()) continue;
          const cacheContent = await searchCacheDir(join(cachePath, ce.name), skillName);
          if (cacheContent) return cacheContent;
        }
      }
    } else {
      // Direct cache search for specific plugin
      const cachePath = join(pluginsDir, "cache", pluginHint);
      if (existsSync(cachePath)) {
        const cacheContent = await searchCacheDir(cachePath, skillName);
        if (cacheContent) return cacheContent;
      }
    }
  } catch {
    // Plugin directory not readable
  }

  return null;
}

async function searchCacheDir(cachePluginDir: string, skillName: string): Promise<string | null> {
  try {
    const subEntries = await readdir(cachePluginDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const innerDir = join(cachePluginDir, sub.name);
      // Look for versioned dirs inside (e.g., 1.0.0/)
      const versionEntries = await readdir(innerDir, { withFileTypes: true });
      for (const ver of versionEntries) {
        if (!ver.isDirectory()) continue;
        const skillPath = join(innerDir, ver.name, "skills", skillName, "SKILL.md");
        const content = await tryReadFile(skillPath);
        if (content) return content;
      }
      // Also check directly (non-versioned)
      const directPath = join(innerDir, "skills", skillName, "SKILL.md");
      const content = await tryReadFile(directPath);
      if (content) return content;
    }
  } catch {
    // Not readable
  }
  return null;
}
