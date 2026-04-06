import { writeFile, unlink, readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { getPidPath, cleanupPidFile } from "../pid";
import { getSession } from "../sessions";
import { getSettings, type SecurityConfig } from "../config";
import { getMemoryPath } from "../memory";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

async function preShutdownMemorySave(): Promise<void> {
  const session = await getSession();
  if (!session) return;

  const settings = getSettings();
  const memPath = getMemoryPath();
  console.log(`[shutdown] Saving memory to ${memPath}...`);

  try {
    // Always include Write tool so memory can be saved regardless of security level
    const securityArgs = ["--dangerously-skip-permissions"];
    if (settings.security.level === "locked") {
      securityArgs.push("--tools", "Read,Grep,Glob,Write");
    }

    const proc = Bun.spawn(
      ["claude", "-p",
        `Session is shutting down. Save your current memory to ${memPath} now. Include: current status, what was accomplished, key context for next session.`,
        "--output-format", "text",
        "--resume", session.sessionId,
        ...securityArgs,
        "--model", settings.model || "haiku",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 }
    );
    await proc.exited;
    console.log("[shutdown] Memory saved.");
  } catch (e) {
    console.warn("[shutdown] Memory save failed:", e);
  }
}

export async function stop() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  // Save memory before killing
  await preShutdownMemorySave();

  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Stopped daemon (PID ${pid}).`);
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  await cleanupPidFile();
  await teardownStatusline();

  try {
    await unlink(join(HEARTBEAT_DIR, "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function stopAll() {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    console.log("No projects found.");
    process.exit(0);
  }

  let found = 0;
  for (const dir of dirs) {
    const projectPath = "/" + dir.slice(1).replace(/-/g, "/");
    const pidFile = join(projectPath, ".claude", "claudeclaw", "daemon.pid");

    let pid: string;
    try {
      pid = (await readFile(pidFile, "utf-8")).trim();
      process.kill(Number(pid), 0);
    } catch {
      continue;
    }

    found++;
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`\x1b[33m■ Stopped\x1b[0m PID ${pid} — ${projectPath}`);
      try { await unlink(pidFile); } catch {}
    } catch {
      console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${pid} — ${projectPath}`);
    }
  }

  if (found === 0) {
    console.log("No running daemons found.");
  }

  process.exit(0);
}
