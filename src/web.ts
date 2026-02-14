import { join } from "path";
import { readFile, readdir, stat, writeFile } from "fs/promises";
import type { Job } from "./jobs";
import type { Settings } from "./config";
import { peekSession } from "./sessions";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");

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

      if (url.pathname === "/api/settings/heartbeat" && req.method === "POST") {
        try {
          const body = await req.json();
          const enabled = Boolean((body as { enabled?: unknown }).enabled);
          await setHeartbeatEnabled(enabled);
          return json({ ok: true, enabled });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
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

async function setHeartbeatEnabled(enabled: boolean): Promise<void> {
  const raw = await readFile(SETTINGS_FILE, "utf-8");
  const data = JSON.parse(raw) as Record<string, any>;
  if (!data.heartbeat || typeof data.heartbeat !== "object") data.heartbeat = {};
  data.heartbeat.enabled = enabled;
  await writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
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
      width: 12ch;
      margin: 0 auto 18px;
      transform: translateX(-0.75ch);
      color: #dbe7ff;
      filter: drop-shadow(0 8px 20px #00000040);
    }
    .logo-top {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8ch;
      font-size: 18px;
      line-height: 1.1;
      margin-bottom: 2px;
      transform: translateX(1.35ch);
    }
    .logo-body {
      margin: 0;
      white-space: pre;
      font-family: "JetBrains Mono", monospace;
      font-size: 20px;
      letter-spacing: 0;
      line-height: 1.08;
      text-align: left;
    }
    .typewriter {
      margin: 6px 0 14px;
      min-height: 1.4em;
      font-family: "JetBrains Mono", monospace;
      font-size: clamp(0.9rem, 1.8vw, 1.05rem);
      color: #c8d6ec;
      letter-spacing: 0.02em;
    }
    .typewriter::after {
      content: "";
      display: inline-block;
      width: 0.62ch;
      height: 1.05em;
      margin-left: 0.18ch;
      vertical-align: -0.12em;
      background: #c8d6ec;
      animation: caret 1s step-end infinite;
    }

    @keyframes caret {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
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
    .settings-btn {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 5;
      border: 1px solid #ffffff2a;
      background: #0b1220c7;
      color: #dce7f8;
      backdrop-filter: blur(8px);
      border-radius: 999px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 10px 14px;
      cursor: pointer;
      transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease;
    }
    .settings-btn:hover {
      transform: translateY(-1px);
      background: #122038d0;
      border-color: #ffffff45;
    }
    .settings-modal {
      position: fixed;
      top: 60px;
      right: 18px;
      width: min(300px, calc(100vw - 36px));
      z-index: 6;
      border: 1px solid #ffffff26;
      border-radius: 14px;
      background: #0b1220eb;
      backdrop-filter: blur(10px);
      box-shadow: 0 18px 36px #0000005a;
      padding: 12px;
      display: none;
    }
    .settings-modal.open { display: block; }
    .settings-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #9eb5d6;
      margin-bottom: 10px;
    }
    .settings-close {
      border: none;
      background: transparent;
      color: #9eb5d6;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
    }
    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #ffffff16;
      background: #08101c;
    }
    .settings-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .settings-label {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #c8d4e8;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .hb-toggle {
      border: 1px solid #ffffff2a;
      background: #0f1b2d;
      color: #dce7f8;
      border-radius: 999px;
      min-width: 92px;
      padding: 7px 10px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
    }
    .hb-toggle.on {
      background: #113424;
      border-color: #67f0b560;
      color: #67f0b5;
    }
    .hb-toggle.off {
      background: #341818;
      border-color: #ff7f7f55;
      color: #ff9b9b;
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
  <button class="settings-btn" id="settings-btn" type="button">Settings</button>
  <aside class="settings-modal" id="settings-modal" aria-live="polite">
    <div class="settings-head">
      <span>Settings</span>
      <button class="settings-close" id="settings-close" type="button" aria-label="Close settings">×</button>
    </div>
    <div class="settings-stack">
      <div class="settings-row">
        <div class="settings-label">💓 Heartbeat</div>
        <button class="hb-toggle" id="hb-toggle" type="button">Loading...</button>
      </div>
      <div class="settings-row">
        <div class="settings-label">🕒 Clock</div>
        <button class="hb-toggle" id="clock-toggle" type="button">24h</button>
      </div>
    </div>
  </aside>
  <main class="stage">
    <section class="hero">
      <div class="logo-art" role="img" aria-label="Lobster ASCII art logo">
        <div class="logo-top"><span>🦞</span><span>🦞</span></div>
        <pre class="logo-body">   ▐▛███▜▌
  ▝▜█████▛▘
    ▘▘ ▝▝</pre>
      </div>
      <div class="typewriter" id="typewriter" aria-live="polite"></div>
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
    const typewriterEl = $("typewriter");
    const settingsBtn = $("settings-btn");
    const settingsModal = $("settings-modal");
    const settingsClose = $("settings-close");
    const hbToggle = $("hb-toggle");
    const clockToggle = $("clock-toggle");
    let use12Hour = localStorage.getItem("clock.format") === "12";

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

    const typePhrases = [
      "Okay human, let's do it.",
      "Build. Refine. Ship.",
      "Keep it simple. Keep it clean.",
      "One focused step at a time.",
      "Clock is live. Let's move."
    ];

    function startTypewriter() {
      let phraseIndex = 0;
      let charIndex = 0;
      let deleting = false;

      function step() {
        const phrase = typePhrases[phraseIndex];
        if (!typewriterEl) return;

        if (!deleting) {
          charIndex = Math.min(charIndex + 1, phrase.length);
          typewriterEl.textContent = phrase.slice(0, charIndex);
          if (charIndex === phrase.length) {
            deleting = true;
            setTimeout(step, 1200);
            return;
          }
          setTimeout(step, 46 + Math.floor(Math.random() * 45));
          return;
        }

        charIndex = Math.max(charIndex - 1, 0);
        typewriterEl.textContent = phrase.slice(0, charIndex);
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % typePhrases.length;
          setTimeout(step, 280);
          return;
        }
        setTimeout(step, 26 + Math.floor(Math.random() * 30));
      }

      step();
    }

    function renderClock() {
      const now = new Date();
      const rawH = now.getHours();
      const hh = use12Hour ? String((rawH % 12) || 12).padStart(2, "0") : String(rawH).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      const suffix = use12Hour ? (rawH >= 12 ? " PM" : " AM") : "";
      clockEl.textContent = hh + ":" + mm + ":" + ss + suffix;
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

    async function loadSettings() {
      if (!hbToggle) return;
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        const on = Boolean(data?.heartbeat?.enabled);
        hbToggle.textContent = on ? "Enabled" : "Disabled";
        hbToggle.className = "hb-toggle " + (on ? "on" : "off");
        hbToggle.dataset.enabled = on ? "1" : "0";
      } catch (err) {
        hbToggle.textContent = "Error";
        hbToggle.className = "hb-toggle off";
      }
    }

    if (settingsBtn && settingsModal) {
      settingsBtn.addEventListener("click", async () => {
        settingsModal.classList.toggle("open");
        if (settingsModal.classList.contains("open")) await loadSettings();
      });
    }

    if (settingsClose && settingsModal) {
      settingsClose.addEventListener("click", () => settingsModal.classList.remove("open"));
    }

    if (hbToggle) {
      hbToggle.addEventListener("click", async () => {
        const current = hbToggle.dataset.enabled === "1";
        hbToggle.textContent = "Saving...";
        try {
          const res = await fetch("/api/settings/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !current }),
          });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "save failed");
          await loadSettings();
          await refreshState();
        } catch {
          hbToggle.textContent = "Failed";
          hbToggle.className = "hb-toggle off";
        }
      });
    }

    function renderClockToggle() {
      if (!clockToggle) return;
      clockToggle.textContent = use12Hour ? "12h" : "24h";
      clockToggle.className = "hb-toggle " + (use12Hour ? "on" : "off");
    }

    if (clockToggle) {
      renderClockToggle();
      clockToggle.addEventListener("click", () => {
        use12Hour = !use12Hour;
        localStorage.setItem("clock.format", use12Hour ? "12" : "24");
        renderClockToggle();
        renderClock();
      });
    }

    function esc(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    renderClock();
    setInterval(renderClock, 1000);
    startTypewriter();

    refreshState();
    setInterval(refreshState, 5000);
  </script>
</body>
</html>`;
}
