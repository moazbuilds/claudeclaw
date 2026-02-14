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
  <title>ClaudeClaw New Tab</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg-top: #142333;
      --bg-bottom: #05070e;
      --text: #f0f4fb;
      --muted: #a8b4c5;
      --panel: #0b1220aa;
      --border: #d8e4ff1f;
      --accent: #9be7ff;
      --good: #67f0b5;
      --bad: #ff7f7f;
      --warn: #ffc276;
    }

    * { box-sizing: border-box; }

    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
    }

    body {
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1400px 700px at 15% -10%, #4c88d433, transparent 60%),
        radial-gradient(900px 500px at 85% 10%, #78c5ff2b, transparent 65%),
        linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      overflow: hidden;
      position: relative;
    }

    .grain {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.08;
      background-image: radial-gradient(#fff 0.5px, transparent 0.5px);
      background-size: 3px 3px;
      animation: drift 16s linear infinite;
    }

    @keyframes drift {
      from { transform: translateY(0); }
      to { transform: translateY(-12px); }
    }

    .stage {
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 32px 16px 120px;
      position: relative;
      z-index: 1;
    }

    .hero {
      text-align: center;
      max-width: 820px;
      animation: rise 700ms ease-out both;
    }

    .logo-art {
      margin: 0 0 18px;
      font-family: "JetBrains Mono", monospace;
      font-size: clamp(0.72rem, 1.8vw, 0.95rem);
      line-height: 1.15;
      letter-spacing: 0.02em;
      color: #dbe7ff;
      text-shadow: 0 8px 20px #00000040;
      white-space: pre;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .time {
      font-family: "Fraunces", serif;
      font-size: clamp(4.2rem, 15vw, 10rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 10px 35px #00000055;
      transition: text-shadow 280ms ease;
    }

    .time.ms-pulse {
      text-shadow: 0 10px 40px #7dc5ff4d;
    }

    .date {
      margin-top: 14px;
      font-size: clamp(1rem, 2.4vw, 1.3rem);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
    }

    .message {
      margin-top: 28px;
      font-size: clamp(1rem, 2.1vw, 1.35rem);
      color: #e4ecf8;
      font-weight: 500;
    }

    .dock {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      width: min(980px, calc(100% - 24px));
      border: 1px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(8px);
      border-radius: 18px;
      padding: 12px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
      z-index: 2;
      box-shadow: 0 15px 40px #0000004f;
    }

    .pill {
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid #ffffff21;
      background: #0d182733;
      color: #dce7f8;
      font-size: 12px;
      letter-spacing: 0.02em;
      white-space: nowrap;
      font-family: "JetBrains Mono", monospace;
    }

    .pill.ok { border-color: #67f0b542; color: var(--good); }
    .pill.warn { border-color: #ffc27652; color: var(--warn); }
    .pill.bad { border-color: #ff7f7f47; color: var(--bad); }

    @media (max-width: 640px) {
      .stage {
        padding-bottom: 160px;
      }
      .dock {
        bottom: 14px;
      }
      .pill {
        font-size: 11px;
      }
    }
  </style>
</head>
<body>
  <div class="grain" aria-hidden="true"></div>
  <main class="stage">
    <section class="hero">
      <pre class="logo-art" aria-hidden="true">🦞         🦞
   ▐▛███▜▌
  ▝▜█████▛▘
    ▘▘ ▝▝</pre>
      <div class="time" id="clock">--:--:--</div>
      <div class="date" id="date">Loading date...</div>
      <div class="message" id="message">Welcome back.</div>
    </section>
  </main>

  <footer class="dock" id="dock" aria-live="polite">
    <div class="pill">Connecting...</div>
  </footer>

  <script>
    const $ = (id) => document.getElementById(id);

    const clockEl = $("clock");
    const dateEl = $("date");
    const msgEl = $("message");
    const dockEl = $("dock");

    const dateFmt = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    function greetingForHour(h) {
      if (h < 5) return "Night shift mode.";
      if (h < 12) return "Good morning.";
      if (h < 18) return "Good afternoon.";
      if (h < 22) return "Good evening.";
      return "Wind down and ship clean.";
    }

    function renderClock() {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      clockEl.textContent = hh + ":" + mm + ":" + ss;
      dateEl.textContent = dateFmt.format(now);
      msgEl.textContent = greetingForHour(now.getHours());

      // Subtle 1s pulse to keep the clock feeling alive.
      clockEl.classList.remove("ms-pulse");
      requestAnimationFrame(() => clockEl.classList.add("ms-pulse"));
    }

    function buildPills(state) {
      const pills = [];
      pills.push({
        cls: "ok",
        text: "daemon pid " + state.daemon.pid + " up " + fmtDur(state.daemon.uptimeMs),
      });

      if (state.heartbeat.enabled) {
        pills.push({ cls: "ok", text: "heartbeat every " + state.heartbeat.intervalMinutes + "m" });
      } else {
        pills.push({ cls: "bad", text: "heartbeat disabled" });
      }

      pills.push({
        cls: state.security.level === "unrestricted" ? "warn" : "ok",
        text: "security " + state.security.level,
      });

      pills.push({
        cls: state.telegram.configured ? "ok" : "warn",
        text: state.telegram.configured
          ? "telegram " + state.telegram.allowedUserCount + " user" + (state.telegram.allowedUserCount !== 1 ? "s" : "")
          : "telegram not configured",
      });

      pills.push({
        cls: state.jobs.length ? "ok" : "warn",
        text: "jobs " + state.jobs.length,
      });

      if (state.session) {
        pills.push({ cls: "ok", text: "session " + state.session.sessionIdShort });
      }

      return pills;
    }

    function fmtDur(ms) {
      if (ms == null) return "n/a";
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m " + ss + "s";
      return ss + "s";
    }

    async function refreshState() {
      try {
        const res = await fetch("/api/state");
        const state = await res.json();
        const pills = buildPills(state);
        dockEl.innerHTML = pills.map((p) => '<div class="pill ' + p.cls + '">' + esc(p.text) + '</div>').join("");
      } catch (err) {
        dockEl.innerHTML = '<div class="pill bad">offline: ' + esc(String(err)) + '</div>';
      }
    }

    function esc(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    renderClock();
    setInterval(renderClock, 1000);

    refreshState();
    setInterval(refreshState, 5000);
  </script>
</body>
</html>`;
}
