import { join } from "path";
import { readFile, readdir, stat } from "fs/promises";
import type { Job } from "./jobs";
import type { Settings } from "./config";
import { peekSession } from "./sessions";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

export interface WebSnapshot {
  pid: number;
  startedAt: number;
  heartbeatNextAt: number;
  settings: Settings;
  jobs: Job[];
}

export interface WebServerHandle {
  stop: () => void;
  host: string;
  port: number;
}

export function startWebUi(opts: {
  host: string;
  port: number;
  getSnapshot: () => WebSnapshot;
}): WebServerHandle {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true, now: Date.now() });
      }

      if (url.pathname === "/api/state") {
        return json(await buildState(opts.getSnapshot()));
      }

      if (url.pathname === "/api/settings") {
        return json(sanitizeSettings(opts.getSnapshot().settings));
      }

      if (url.pathname === "/api/jobs") {
        const jobs = opts.getSnapshot().jobs.map((j) => ({
          name: j.name,
          schedule: j.schedule,
          promptPreview: j.prompt.slice(0, 160),
        }));
        return json({ jobs });
      }

      if (url.pathname === "/api/logs") {
        const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
        return json(await readLogs(tail));
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(),
    host: opts.host,
    port: server.port,
  };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sanitizeSettings(settings: Settings) {
  return {
    heartbeat: settings.heartbeat,
    security: settings.security,
    telegram: {
      configured: Boolean(settings.telegram.token),
      allowedUserCount: settings.telegram.allowedUserIds.length,
    },
    web: settings.web,
  };
}

async function buildState(snapshot: WebSnapshot) {
  const now = Date.now();
  const session = await peekSession();
  return {
    daemon: {
      running: true,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: now - snapshot.startedAt,
    },
    heartbeat: {
      enabled: snapshot.settings.heartbeat.enabled,
      intervalMinutes: snapshot.settings.heartbeat.interval,
      nextAt: snapshot.heartbeatNextAt || null,
      nextInMs: snapshot.heartbeatNextAt ? Math.max(0, snapshot.heartbeatNextAt - now) : null,
    },
    jobs: snapshot.jobs.map((j) => ({ name: j.name, schedule: j.schedule })),
    security: snapshot.settings.security,
    telegram: {
      configured: Boolean(snapshot.settings.telegram.token),
      allowedUserCount: snapshot.settings.telegram.allowedUserIds.length,
    },
    session: session
      ? {
          sessionIdShort: session.sessionId.slice(0, 8),
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        }
      : null,
    web: snapshot.settings.web,
  };
}

async function readLogs(tail: number) {
  const daemonLog = await readTail(join(LOGS_DIR, "daemon.log"), tail);
  const runs = await readRecentRunLogs(tail);
  return { daemonLog, runs };
}

async function readRecentRunLogs(tail: number) {
  let files: string[] = [];
  try {
    files = await readdir(LOGS_DIR);
  } catch {
    return [];
  }

  const candidates = files
    .filter((f) => f.endsWith(".log") && f !== "daemon.log")
    .slice(0, 200);

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(LOGS_DIR, name);
      try {
        const s = await stat(path);
        return { name, path, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  return await Promise.all(
    withStats
      .filter((x): x is { name: string; path: string; mtime: number } => Boolean(x))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
      .map(async ({ name, path }) => ({
        file: name,
        lines: await readTail(path, tail),
      }))
  );
}

async function readTail(path: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(path, "utf-8");
    const all = text.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).filter(Boolean);
  } catch {
    return [];
  }
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClaudeClaw Dashboard</title>
  <style>
    :root { --bg:#f6f4ef; --card:#fffdf8; --ink:#182025; --muted:#5b6770; --line:#ded7c9; --accent:#c14b21; --ok:#1f7a1f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:"IBM Plex Sans",ui-sans-serif,sans-serif; background:radial-gradient(circle at 0% 0%, #fff4e4, var(--bg) 40%); color:var(--ink); }
    .wrap { max-width:1000px; margin:0 auto; padding:20px; }
    h1 { margin:0 0 14px; font-size:28px; letter-spacing:.3px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; box-shadow:0 6px 18px rgba(20,22,25,.06); }
    .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .v { font-weight:700; margin-top:6px; font-size:18px; }
    .ok { color:var(--ok); } .warn { color:var(--accent); }
    pre { background:#171717; color:#e7e7e7; padding:12px; border-radius:10px; overflow:auto; max-height:360px; margin:0; font-size:12px; }
    .row { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .small { font-size:12px; color:var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <h1>ClaudeClaw Dashboard</h1>
      <div class="small" id="updated"></div>
    </div>
    <div class="grid">
      <div class="card"><div class="k">Daemon</div><div class="v" id="daemon">-</div></div>
      <div class="card"><div class="k">Heartbeat</div><div class="v" id="heartbeat">-</div></div>
      <div class="card"><div class="k">Jobs</div><div class="v" id="jobs">-</div></div>
      <div class="card"><div class="k">Security</div><div class="v" id="security">-</div></div>
      <div class="card"><div class="k">Telegram</div><div class="v" id="telegram">-</div></div>
      <div class="card"><div class="k">Session</div><div class="v" id="session">-</div></div>
    </div>
    <div class="card" style="margin-top:12px;">
      <div class="k">Recent Logs</div>
      <pre id="logs">Loading...</pre>
    </div>
  </div>
  <script>
    const el = (id) => document.getElementById(id);
    const fmtDur = (ms) => {
      if (ms == null) return "n/a";
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      if (h) return h + "h " + m + "m";
      if (m) return m + "m " + ss + "s";
      return ss + "s";
    };
    async function tick() {
      const [stateRes, logsRes] = await Promise.all([
        fetch("/api/state"),
        fetch("/api/logs?tail=80"),
      ]);
      const state = await stateRes.json();
      const logs = await logsRes.json();

      el("daemon").innerHTML = '<span class="ok">running</span> PID ' + state.daemon.pid + ' | up ' + fmtDur(state.daemon.uptimeMs);
      el("heartbeat").textContent = state.heartbeat.enabled
        ? "every " + state.heartbeat.intervalMinutes + "m, next in " + fmtDur(state.heartbeat.nextInMs)
        : "disabled";
      el("jobs").textContent = state.jobs.length + " loaded";
      el("security").textContent = state.security.level;
      el("telegram").textContent = state.telegram.configured
        ? "configured (" + state.telegram.allowedUserCount + " users)"
        : "not configured";
      el("session").textContent = state.session ? state.session.sessionIdShort + "..." : "not created";

      const daemonLines = (logs.daemonLog || []).slice(-30);
      const runLines = [];
      for (const run of (logs.runs || [])) {
        runLines.push("== " + run.file + " ==");
        runLines.push(...(run.lines || []).slice(-20));
      }
      el("logs").textContent = [...daemonLines, ...runLines].join("\\n") || "(no logs yet)";
      el("updated").textContent = "Updated: " + new Date().toLocaleTimeString();
    }
    tick().catch((e) => { el("logs").textContent = String(e); });
    setInterval(() => tick().catch(() => {}), 3000);
  </script>
</body>
</html>`;
}
