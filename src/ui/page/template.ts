import { pageStyles } from "./styles";
import { pageScript } from "./script";

function decodeUnicodeEscapes(text: string): string {
  const decodedCodePoints = text.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
  });
  return decodedCodePoints.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
}

export function htmlPage(): string {
  const html = String.raw`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClaudeClaw New Tab</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
${pageStyles}
  </style>
</head>
<body>
  <div class="grain" aria-hidden="true"></div>
  <a
    class="repo-cta"
    href="https://github.com/moazbuilds/claudeclaw"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Star claudeclaw on GitHub"
  >
    <span class="repo-text">Like ClaudeClaw? Star it on GitHub</span>
    <span class="repo-star">★</span>
  </a>
  <button class="settings-btn" id="settings-btn" type="button">Settings</button>
  <aside class="settings-modal" id="settings-modal" aria-live="polite">
    <div class="settings-head">
      <span>Settings</span>
      <button class="settings-close" id="settings-close" type="button" aria-label="Close settings">×</button>
    </div>
    <div class="settings-stack">
      <div class="setting-item">
        <div class="setting-main">
          <div class="settings-label">💓 Heartbeat</div>
          <div class="settings-meta" id="hb-info">syncing...</div>
        </div>
        <button class="hb-toggle" id="hb-toggle" type="button">Loading...</button>
      </div>
      <div class="setting-item">
        <div class="setting-main">
          <div class="settings-label">🕒 Clock</div>
          <div class="settings-meta" id="clock-info">24-hour format</div>
        </div>
        <button class="hb-toggle" id="clock-toggle" type="button">24h</button>
      </div>
      <div class="setting-item">
        <div class="setting-main">
          <div class="settings-label">🧾 Advanced</div>
          <div class="settings-meta">Technical runtime and JSON files</div>
        </div>
        <button class="hb-toggle on" id="info-open" type="button">Info</button>
      </div>
    </div>
  </aside>
  <section class="info-modal" id="info-modal" aria-live="polite" aria-hidden="true">
    <article class="info-card">
      <div class="info-head">
        <span>Advanced Technical Info</span>
        <button class="settings-close" id="info-close" type="button" aria-label="Close technical info">×</button>
      </div>
      <div class="info-body" id="info-body">
        <div class="info-section">
          <div class="info-title">Loading</div>
          <pre class="info-json">Loading technical data...</pre>
        </div>
      </div>
    </article>
  </section>
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
      <form class="quick-job" id="quick-job-form">
        <div class="quick-job-head">
          <div class="quick-job-title">Add Scheduled Job</div>
          <div class="quick-job-sub">Daily cron with prompt payload</div>
        </div>
        <div class="quick-job-grid">
          <div class="quick-field quick-time-wrap">
            <div class="quick-label">Delay From Now (Minutes)</div>
            <input class="quick-input" id="quick-job-offset" type="number" min="1" max="1440" step="5" placeholder="60" required />
            <div class="quick-time-buttons">
              <button class="quick-add" type="button" data-add-minutes="15">+15m</button>
              <button class="quick-add" type="button" data-add-minutes="30">+30m</button>
              <button class="quick-add" type="button" data-add-minutes="60">+1h</button>
              <button class="quick-add" type="button" data-add-minutes="180">+3h</button>
            </div>
            <div class="quick-preview" id="quick-job-preview">Runs in -- min</div>
          </div>
          <div class="quick-field">
            <div class="quick-label">Prompt</div>
            <textarea class="quick-prompt" id="quick-job-prompt" placeholder="Prompt for this scheduled run..." required></textarea>
            <div class="quick-prompt-meta">
              <span id="quick-job-count">0 chars</span>
              <span>Saved at computed clock time</span>
            </div>
          </div>
        </div>
        <div class="quick-job-actions">
          <button class="quick-submit" id="quick-job-submit" type="submit">Add to Jobs List</button>
          <div class="quick-status" id="quick-job-status"></div>
        </div>
        <div class="quick-jobs">
          <div class="quick-label">Jobs List</div>
          <div class="quick-jobs-list" id="quick-jobs-list">
            <div class="quick-jobs-empty">No jobs yet.</div>
          </div>
        </div>
      </form>
    </section>
  </main>

  <div class="dock-shell">
    <aside class="side-bubble" id="jobs-bubble" aria-live="polite">
      <div class="side-icon">🗂️</div>
      <div class="side-value">-</div>
      <div class="side-label">Jobs</div>
    </aside>
    <footer class="dock" id="dock" aria-live="polite">
      <div class="pill">Connecting...</div>
    </footer>
    <aside class="side-bubble" id="uptime-bubble" aria-live="polite">
      <div class="side-icon">⏱️</div>
      <div class="side-value">-</div>
      <div class="side-label">Uptime</div>
    </aside>
  </div>

  <script>
${pageScript}
  </script>
</body>
</html>`;
  return decodeUnicodeEscapes(html);
}
