// preflight.ts — Install Claude Code plugins on first run
// Skips any plugin that is already installed.

import { execSync, type ExecSyncOptions } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  rmSync,
  renameSync,
  type Dirent,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";

// ── Plugin repos to install (one plugin per repo) ───────────────────
const PLUGINS = [
  "https://github.com/SawyerHood/dev-browser",
  "https://github.com/thedotmack/claude-mem",
  "https://github.com/obra/superpowers-marketplace",
  // Add more repos here:
  // "https://github.com/user/repo",
];

// ── Cherry-pick from anthropics/claude-plugins-official ─────────────
const OFFICIAL_PLUGINS = [
  "ralph-loop",
  "hookify",
  "code-review",
  "pr-review-toolkit",
  "commit-commands",
  "plugin-dev",
  // Add more plugin names here (must match names in marketplace.json):
  // "typescript-lsp",
  // "playwright",
];

// ── Config ──────────────────────────────────────────────────────────
const OFFICIAL_REPO = "https://github.com/anthropics/claude-plugins-official";
const PLUGINS_DIR = join(homedir(), ".claude", "plugins");
const INST_FILE = join(PLUGINS_DIR, "installed_plugins.json");
const MKTP_FILE = join(PLUGINS_DIR, "known_marketplaces.json");

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
  projectPath: string;
}

interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

interface MarketplacePlugin {
  name: string;
  skills?: string[];
  source?: string;
}

interface MarketplaceJson {
  name: string;
  plugins: MarketplacePlugin[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function run(cmd: string, opts: ExecSyncOptions = {}): string {
  const result = execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
  return (result ?? "").toString().trim();
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true }) as Dirent[]) {
    if (entry.name === ".git") continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function detectPkgManager(): string | null {
  try { run("bun --version"); return "bun"; } catch {}
  try { run("npm --version"); return "npm"; } catch {}
  return null;
}

function extractRepo(url: string): string {
  return url.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "");
}

function isCached(pluginKey: string): boolean {
  const instData = readJSON<InstalledPlugins>(INST_FILE, { version: 2, plugins: {} });
  const entries = instData.plugins[pluginKey];
  if (!entries || entries.length === 0) return false;
  return entries.some((e) => existsSync(e.installPath));
}

function isEnabledInProject(pluginKey: string, projectPath: string): boolean {
  const projSettings = join(projectPath, ".claude", "settings.json");
  const settings = readJSON<Record<string, unknown>>(projSettings, {});
  const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  return !!enabled?.[pluginKey];
}

function enableInProject(pluginKey: string, projectPath: string): void {
  const projSettings = join(projectPath, ".claude", "settings.json");
  const settings = readJSON<Record<string, unknown>>(projSettings, {});
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  (settings.enabledPlugins as Record<string, boolean>)[pluginKey] = true;
  writeJSON(projSettings, settings);
}

// ── Install a single-repo plugin ────────────────────────────────────

function installRepoPlugin(
  repoUrl: string,
  projectPath: string,
  pkgMgr: string,
): "installed" | "enabled" | "skipped" {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "claude-plugin-"));
    run(`git clone --quiet "${repoUrl}" "${tempDir}"`);

    const marketplaceJsonPath = join(tempDir, ".claude-plugin", "marketplace.json");
    if (!existsSync(marketplaceJsonPath)) {
      console.log(`  skip: ${repoUrl} (no .claude-plugin/marketplace.json)`);
      return "skipped";
    }

    const marketplace: MarketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, "utf-8"));
    const marketplaceName = marketplace.name;
    const pluginName = marketplace.plugins[0].name;
    const skillPath = marketplace.plugins[0].skills?.[0];
    const pluginKey = `${pluginName}@${marketplaceName}`;

    if (isCached(pluginKey) && isEnabledInProject(pluginKey, projectPath)) {
      console.log(`  skip: ${pluginKey} (already installed)`);
      return "skipped";
    }

    if (isCached(pluginKey)) {
      console.log(`  enable: ${pluginKey} (cached, enabling for project)`);
      enableInProject(pluginKey, projectPath);
      return "enabled";
    }

    console.log(`  install: ${pluginKey}`);

    const marketplaceDir = join(PLUGINS_DIR, "marketplaces", marketplaceName);
    if (existsSync(marketplaceDir)) {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
    renameSync(tempDir, marketplaceDir);
    tempDir = null;

    const fullSha = run("git rev-parse HEAD", { cwd: marketplaceDir });
    const shortSha = fullSha.slice(0, 12);

    const cacheDir = join(PLUGINS_DIR, "cache", marketplaceName, pluginName, shortSha);
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    copyDirSync(marketplaceDir, cacheDir);

    if (skillPath) {
      const skillDir = join(cacheDir, skillPath);
      if (existsSync(join(skillDir, "package.json"))) {
        console.log(`    deps: ${pkgMgr} install`);
        run(`${pkgMgr} install`, { cwd: skillDir, stdio: "inherit" });
      }
    }

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const repo = extractRepo(repoUrl);

    const mktpData = readJSON<Record<string, unknown>>(MKTP_FILE, {});
    mktpData[marketplaceName] = {
      source: { source: "github", repo },
      installLocation: marketplaceDir,
      lastUpdated: now,
    };
    writeJSON(MKTP_FILE, mktpData);

    const instData = readJSON<InstalledPlugins>(INST_FILE, { version: 2, plugins: {} });
    instData.plugins[pluginKey] = [
      {
        scope: "project",
        installPath: cacheDir,
        version: shortSha,
        installedAt: now,
        lastUpdated: now,
        gitCommitSha: fullSha,
        projectPath: projectPath,
      },
    ];
    writeJSON(INST_FILE, instData);

    enableInProject(pluginKey, projectPath);
    return "installed";
  } finally {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ── Install cherry-picked plugins from the official monorepo ────────

function installOfficialPlugins(
  pluginNames: string[],
  projectPath: string,
  pkgMgr: string,
): { installed: number; skipped: number } {
  if (pluginNames.length === 0) return { installed: 0, skipped: 0 };

  const marketplaceName = "claude-plugins-official";
  const repo = extractRepo(OFFICIAL_REPO);
  let installed = 0;
  let skipped = 0;

  // Check which plugins actually need work before cloning
  const needed: string[] = [];
  const enableOnly: string[] = [];
  for (const name of pluginNames) {
    const pluginKey = `${name}@${marketplaceName}`;
    if (isCached(pluginKey) && isEnabledInProject(pluginKey, projectPath)) {
      console.log(`  skip: ${pluginKey} (already installed)`);
      skipped++;
    } else if (isCached(pluginKey)) {
      enableOnly.push(name);
    } else {
      needed.push(name);
    }
  }

  // Enable cached ones without cloning
  for (const name of enableOnly) {
    const pluginKey = `${name}@${marketplaceName}`;
    console.log(`  enable: ${pluginKey} (cached, enabling for project)`);
    enableInProject(pluginKey, projectPath);
    installed++;
  }

  // Nothing to clone
  if (needed.length === 0) return { installed, skipped };

  // Clone the monorepo once
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "claude-official-"));
    console.log(`  cloning ${marketplaceName} (${needed.length} plugin(s) to install)...`);
    run(`git clone --quiet --depth 1 "${OFFICIAL_REPO}" "${tempDir}"`);

    const marketplaceJsonPath = join(tempDir, ".claude-plugin", "marketplace.json");
    if (!existsSync(marketplaceJsonPath)) {
      console.error(`  error: ${OFFICIAL_REPO} (no .claude-plugin/marketplace.json)`);
      return { installed, skipped };
    }

    const marketplace: MarketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, "utf-8"));
    const fullSha = run("git rev-parse HEAD", { cwd: tempDir });
    const shortSha = fullSha.slice(0, 12);

    // Save the monorepo to marketplaces dir
    const marketplaceDir = join(PLUGINS_DIR, "marketplaces", marketplaceName);
    if (existsSync(marketplaceDir)) {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
    renameSync(tempDir, marketplaceDir);
    tempDir = null;

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

    // Update known_marketplaces.json once
    const mktpData = readJSON<Record<string, unknown>>(MKTP_FILE, {});
    mktpData[marketplaceName] = {
      source: { source: "github", repo },
      installLocation: marketplaceDir,
      lastUpdated: now,
    };
    writeJSON(MKTP_FILE, mktpData);

    // Install each requested plugin
    for (const name of needed) {
      const pluginDef = marketplace.plugins.find((p) => p.name === name);
      if (!pluginDef) {
        console.log(`  skip: ${name} (not found in ${marketplaceName})`);
        skipped++;
        continue;
      }

      const pluginKey = `${name}@${marketplaceName}`;
      console.log(`  install: ${pluginKey}`);

      // Cache the plugin's source directory
      const sourceDir = pluginDef.source
        ? join(marketplaceDir, pluginDef.source)
        : marketplaceDir;

      const cacheDir = join(PLUGINS_DIR, "cache", marketplaceName, name, shortSha);
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true });
      }

      // Copy the plugin source + the marketplace.json (needed by Claude Code)
      copyDirSync(sourceDir, cacheDir);
      const cacheDotPlugin = join(cacheDir, ".claude-plugin");
      mkdirSync(cacheDotPlugin, { recursive: true });
      copyFileSync(
        join(marketplaceDir, ".claude-plugin", "marketplace.json"),
        join(cacheDotPlugin, "marketplace.json"),
      );

      // Install deps if the plugin has skills with a package.json
      const skillPath = pluginDef.skills?.[0];
      if (skillPath) {
        const skillDir = join(cacheDir, skillPath);
        if (existsSync(join(skillDir, "package.json"))) {
          console.log(`    deps: ${pkgMgr} install`);
          run(`${pkgMgr} install`, { cwd: skillDir, stdio: "inherit" });
        }
      }

      // Register in installed_plugins.json
      const instData = readJSON<InstalledPlugins>(INST_FILE, { version: 2, plugins: {} });
      instData.plugins[pluginKey] = [
        {
          scope: "project",
          installPath: cacheDir,
          version: shortSha,
          installedAt: now,
          lastUpdated: now,
          gitCommitSha: fullSha,
          projectPath: projectPath,
        },
      ];
      writeJSON(INST_FILE, instData);

      enableInProject(pluginKey, projectPath);
      installed++;
    }
  } catch (err: any) {
    console.error(`  error: ${OFFICIAL_REPO} — ${err.message}`);
  } finally {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { installed, skipped };
}

// ── Main ────────────────────────────────────────────────────────────

export function preflight(projectPath: string): void {
  try { run("git --version"); } catch {
    console.error("preflight: git is required but not installed.");
    process.exit(1);
  }

  const pkgMgr = detectPkgManager();
  if (!pkgMgr) {
    console.error("preflight: bun or npm is required.");
    process.exit(1);
  }

  mkdirSync(join(PLUGINS_DIR, "marketplaces"), { recursive: true });
  mkdirSync(join(PLUGINS_DIR, "cache"), { recursive: true });

  let installed = 0;
  let skipped = 0;

  // Standalone repos
  for (const repoUrl of PLUGINS) {
    try {
      const result = installRepoPlugin(repoUrl, projectPath, pkgMgr);
      if (result === "installed" || result === "enabled") installed++;
      else skipped++;
    } catch (err: any) {
      console.error(`  error: ${repoUrl} — ${err.message}`);
    }
  }

  // Official monorepo (cherry-picked)
  const official = installOfficialPlugins(OFFICIAL_PLUGINS, projectPath, pkgMgr);
  installed += official.installed;
  skipped += official.skipped;

  console.log(`preflight: ${installed} installed, ${skipped} skipped`);
}

// Allow standalone: bun run src/preflight.ts [project-path]
if (import.meta.main) {
  preflight(process.argv[2] || process.cwd());
}
