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
  <title>ClaudeClaw</title>
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
        <div class="setting-actions">
          <button class="hb-config" id="hb-config" type="button">Configure</button>
          <button class="hb-toggle" id="hb-toggle" type="button">Loading...</button>
        </div>
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
  <section class="info-modal" id="hb-modal" aria-live="polite" aria-hidden="true">
    <article class="hb-card">
      <div class="info-head">
        <span>Heartbeat Configuration</span>
        <button class="settings-close" id="hb-modal-close" type="button" aria-label="Close heartbeat configuration">×</button>
      </div>
      <form class="hb-form" id="hb-form">
        <label class="hb-field" for="hb-interval-input">
          <span class="hb-label">Interval (minutes)</span>
          <input class="hb-input" id="hb-interval-input" type="number" min="1" max="1440" step="1" required />
        </label>
        <label class="hb-field" for="hb-prompt-input">
          <span class="hb-label">Custom prompt</span>
          <textarea class="hb-textarea" id="hb-prompt-input" placeholder="What should heartbeat run?" required></textarea>
        </label>
        <div class="hb-actions">
          <div class="hb-status" id="hb-modal-status"></div>
          <div class="hb-buttons">
            <button class="hb-btn ghost" id="hb-cancel-btn" type="button">Cancel</button>
            <button class="hb-btn solid" id="hb-save-btn" type="submit">Save</button>
          </div>
        </div>
      </form>
    </article>
  </section>
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
  <nav class="tab-nav">
    <button class="tab-btn tab-btn-active" id="tab-dashboard-btn" type="button">Dashboard</button>
    <button class="tab-btn" id="tab-kanban-btn" type="button">Kanban</button>
  </nav>
  <div id="dashboard-panel">
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
      <section class="quick-job" id="quick-jobs-view">
        <div class="quick-job-head quick-job-head-row">
          <div>
            <div class="quick-job-title">Jobs List</div>
            <div class="quick-job-sub">Scheduled runs loaded from runtime jobs</div>
            <div class="quick-jobs-next" id="quick-jobs-next">Next job in --</div>
          </div>
          <button class="quick-open-create" id="quick-open-create" type="button">Create Job</button>
        </div>
        <div class="quick-jobs-list quick-jobs-list-main" id="quick-jobs-list">
          <div class="quick-jobs-empty">Loading jobs...</div>
        </div>
        <div class="quick-status" id="quick-jobs-status"></div>
      </section>
      <form class="quick-job quick-view-hidden" id="quick-job-form">
        <div class="quick-job-head">
          <div class="quick-job-title">Add Scheduled Job</div>
          <div class="quick-job-sub">Recurring cron with prompt payload</div>
        </div>
        <div class="quick-job-grid">
          <div class="quick-field quick-time-wrap">
            <div class="quick-label">Delay From Now (Minutes)</div>
            <div class="quick-input-wrap">
            <input class="quick-input" id="quick-job-offset" type="number" min="1" max="1440" step="1" placeholder="10" required />
              <label class="quick-check quick-check-inline" for="quick-job-recurring">
                <input id="quick-job-recurring" type="checkbox" checked />
                <span>Recurring</span>
              </label>
            </div>
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
            <textarea class="quick-prompt" id="quick-job-prompt" placeholder="Remind me to drink water." required></textarea>
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
        <div class="quick-form-foot">
          <button class="quick-back-jobs" id="quick-back-jobs" type="button">Back to Jobs List</button>
        </div>
      </form>
    </section>
  </main>
  </div>
  <div id="kanban-panel" hidden>
    <div class="kanban-board">
      <div class="kanban-col" id="kanban-col-todo">
        <div class="kanban-col-header">
          <div class="kanban-col-title-group">
            <div class="kanban-col-indicator kanban-indicator-todo"></div>
            <span class="kanban-col-title">To Do</span>
            <span class="kanban-col-count" id="kanban-count-todo">0</span>
          </div>
        </div>
        <div class="kanban-cards" id="kanban-cards-todo"></div>
      </div>
      <div class="kanban-col" id="kanban-col-inprogress">
        <div class="kanban-col-header">
          <div class="kanban-col-title-group">
            <div class="kanban-col-indicator kanban-indicator-inprogress"></div>
            <span class="kanban-col-title">In Progress</span>
            <span class="kanban-col-count" id="kanban-count-inprogress">0</span>
          </div>
        </div>
        <div class="kanban-cards" id="kanban-cards-inprogress"></div>
      </div>
      <div class="kanban-col" id="kanban-col-done">
        <div class="kanban-col-header">
          <div class="kanban-col-title-group">
            <div class="kanban-col-indicator kanban-indicator-done"></div>
            <span class="kanban-col-title">Done</span>
            <span class="kanban-col-count" id="kanban-count-done">0</span>
          </div>
          <button class="kanban-clear-btn" onclick="clearKanbanDone()" type="button">Clear</button>
        </div>
        <div class="kanban-cards" id="kanban-cards-done"></div>
      </div>
    </div>
    <div class="kanban-toolbar">
      <button class="kanban-add-btn" id="kanban-add-btn" type="button">+ Add task</button>
    </div>
    <!-- Add task modal -->
    <div class="kanban-modal-overlay" id="kanban-modal-overlay" hidden>
      <div class="kanban-modal">
        <div class="kanban-modal-header">
          <span>Add task</span>
          <button class="kanban-modal-close" id="kanban-modal-close" type="button">×</button>
        </div>
        <div class="kanban-modal-body">
          <input class="kanban-input" id="kanban-input-title" placeholder="Task title" type="text" />
          <textarea class="kanban-input kanban-textarea" id="kanban-input-desc" placeholder="Description (optional)" rows="3"></textarea>
        </div>
        <div class="kanban-modal-footer">
          <button class="kanban-btn-secondary" id="kanban-cancel-btn" type="button">Cancel</button>
          <button class="kanban-btn-primary" id="kanban-save-btn" type="button">Add to To Do</button>
        </div>
      </div>
    </div>
  </div>

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
