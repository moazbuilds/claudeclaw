export const pageStyles = String.raw`    :root {
      --bg-top: #2a4262;
      --bg-bottom: #0d1828;
      --bg-spot-a: #7fb8ff3d;
      --bg-spot-b: #95d1ff38;
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
      min-height: 100%;
      margin: 0;
    }

    body {
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1400px 700px at 15% -10%, var(--bg-spot-a), transparent 60%),
        radial-gradient(900px 500px at 85% 10%, var(--bg-spot-b), transparent 65%),
        linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      overflow-x: hidden;
      overflow-y: auto;
      position: relative;
      transition: background 320ms ease;
    }

    body.day-mode {
      --bg-top: #2a4262;
      --bg-bottom: #0d1828;
      --bg-spot-a: #7fb8ff3d;
      --bg-spot-b: #95d1ff38;
    }

    body.night-mode {
      --bg-top: #101b2a;
      --bg-bottom: #02040a;
      --bg-spot-a: #3557822b;
      --bg-spot-b: #4a7ab42a;
    }

    body.night-mode .message {
      color: #d2ddef;
      font-family: "JetBrains Mono", monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
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
      min-height: 100vh;
      display: grid;
      justify-items: center;
      align-items: start;
      padding: 64px 16px 120px;
      position: relative;
      z-index: 1;
    }

    .hero {
      text-align: center;
      width: min(820px, 100%);
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
      display: block;
      width: 100%;
      font-family: "Fraunces", serif;
      font-size: clamp(4.2rem, 15vw, 10rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
      font-variant-numeric: tabular-nums;
      text-align: center;
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
    .quick-job {
      margin: 20px auto 0;
      width: min(720px, 100%);
      padding: 14px;
      border: 1px solid #ffffff22;
      border-radius: 16px;
      background:
        radial-gradient(120% 100% at 100% 0%, #7dc5ff1a, transparent 55%),
        linear-gradient(180deg, #0e1a2a88 0%, #0a1220a8 100%);
      backdrop-filter: blur(6px);
      box-shadow: 0 14px 34px #00000045;
      display: grid;
      gap: 12px;
      text-align: left;
    }
    .quick-job-head {
      display: grid;
      gap: 3px;
    }
    .quick-job-head-row {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 10px;
    }
    .quick-job-title {
      font-family: "Fraunces", serif;
      font-size: clamp(1.1rem, 2.2vw, 1.4rem);
      letter-spacing: 0.01em;
      color: #f4f8ff;
      line-height: 1.1;
    }
    .quick-job-sub {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #c9daef;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .quick-jobs-next {
      margin-top: 6px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #9fd6ff;
      letter-spacing: 0.03em;
    }
    .quick-job-grid {
      display: grid;
      grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
      gap: 10px;
      align-items: stretch;
    }
    .quick-field {
      border: 1px solid #ffffff1c;
      border-radius: 12px;
      background: #0c1624a6;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .quick-label {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #bfd4ef;
    }
    .quick-input,
    .quick-prompt,
    .quick-submit {
      border: 0;
      font-family: "JetBrains Mono", monospace;
      font-size: 13px;
      color: #eef4ff;
      background: transparent;
    }
    .quick-input {
      height: 42px;
      width: 100%;
      padding: 0 11px;
      border-radius: 10px;
      border: 1px solid #ffffff2e;
      background: #ffffff09;
      appearance: textfield;
      -moz-appearance: textfield;
    }
    .quick-input::-webkit-outer-spin-button,
    .quick-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .quick-input-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 42px;
      padding: 0 6px 0 11px;
      border-radius: 10px;
      border: 1px solid #ffffff2e;
      background: #ffffff09;
    }
    .quick-input-wrap .quick-input {
      height: 100%;
      flex: 1 1 auto;
      min-width: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      padding: 0;
    }
    .quick-input:focus-visible,
    .quick-prompt:focus-visible {
      outline: 1px solid #7dc5ff88;
      outline-offset: 1px;
    }
    .quick-input-wrap:focus-within {
      outline: 1px solid #7dc5ff88;
      outline-offset: 1px;
    }
    .quick-input-wrap .quick-input:focus-visible {
      outline: none;
    }
    .quick-time-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .quick-add {
      height: 27px;
      padding: 0 10px;
      border: 1px solid #ffffff2c;
      border-radius: 999px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.03em;
      color: #daebff;
      background: #ffffff12;
      cursor: pointer;
      transition: background 0.16s ease, transform 0.16s ease, border-color 0.16s ease;
    }
    .quick-add:hover {
      background: #ffffff22;
      border-color: #ffffff44;
      transform: translateY(-1px);
    }
    .quick-preview {
      min-height: 1.2em;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #a8f1ca;
    }
    .quick-check {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: fit-content;
      min-height: 29px;
      padding: 0 12px;
      border: 1px solid #ff7f7f55;
      border-radius: 999px;
      background: #34181855;
      color: #ff9b9b;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
      user-select: none;
    }
    .quick-check-inline {
      position: static;
      min-height: 28px;
      padding: 0 10px;
      flex: 0 0 auto;
    }
    .quick-check:hover {
      transform: translateY(-1px);
    }
    .quick-check-inline:hover {
      transform: none;
    }
    .quick-check:has(input:checked) {
      background: #11342455;
      border-color: #67f0b560;
      color: #67f0b5;
    }
    .quick-check input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .quick-check:focus-within {
      outline: 1px solid #7dc5ff88;
      outline-offset: 2px;
    }
    .quick-prompt {
      width: 100%;
      min-height: 106px;
      padding: 10px 11px;
      resize: vertical;
      border: 1px solid #ffffff2e;
      border-radius: 10px;
      background: #ffffff09;
      line-height: 1.4;
    }
    .quick-prompt-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #c3d6ef;
    }
    .quick-job-actions {
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .quick-submit {
      height: 42px;
      width: 100%;
      cursor: pointer;
      border-radius: 999px;
      border: 1px solid #3cb87980;
      background: linear-gradient(180deg, #1f6f47d4 0%, #18563ace 100%);
      color: #c8f8de;
      font-weight: 600;
      transition: transform 0.16s ease, filter 0.16s ease, opacity 0.16s ease;
    }
    .quick-submit:hover {
      transform: translateY(-1px);
      filter: brightness(1.06);
    }
    .quick-submit:disabled {
      opacity: 0.72;
      cursor: wait;
      transform: none;
      filter: none;
    }
    .quick-status {
      min-height: 1.2em;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #cde0f7;
      opacity: 0.95;
    }
    .quick-open-create,
    .quick-back-jobs {
      height: 33px;
      padding: 0 12px;
      border: 1px solid #ffffff2c;
      border-radius: 999px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.03em;
      color: #daebff;
      background: #ffffff12;
      cursor: pointer;
      transition: background 0.16s ease, transform 0.16s ease, border-color 0.16s ease;
    }
    .quick-open-create:hover,
    .quick-back-jobs:hover {
      background: #ffffff22;
      border-color: #ffffff44;
      transform: translateY(-1px);
    }
    .quick-form-foot {
      border-top: 1px solid #ffffff1a;
      padding-top: 10px;
      display: flex;
      justify-content: flex-end;
    }
    .quick-jobs-list {
      display: grid;
      gap: 6px;
      max-height: 170px;
      overflow: auto;
      padding-right: 4px;
    }
    .quick-jobs-list-main {
      max-height: 280px;
    }
    .quick-job-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid #ffffff1d;
      border-radius: 10px;
      background: #0b1422a8;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
    }
    .quick-job-item-main {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .quick-job-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
      border: 0;
      padding: 0;
      margin: 0;
      background: transparent;
      width: 100%;
      text-align: left;
      color: inherit;
      cursor: pointer;
    }
    .quick-job-item-time {
      color: #bde8ff;
      white-space: nowrap;
    }
    .quick-job-item-name {
      color: #d8e4f7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
    .quick-job-item-cooldown {
      color: #a8f1ca;
      white-space: nowrap;
    }
    .quick-job-item-details {
      border-top: 1px solid #ffffff17;
      margin-top: 2px;
      padding-top: 8px;
      display: grid;
      gap: 6px;
      color: #c7d8ee;
    }
    .quick-job-prompt-full {
      margin: 0;
      padding: 8px;
      border-radius: 8px;
      background: #070f1a;
      border: 1px solid #ffffff14;
      color: #e4eefb;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow: auto;
    }
    .quick-job-delete {
      align-self: center;
      height: 28px;
      padding: 0 10px;
      border: 1px solid #ff7f7f40;
      border-radius: 999px;
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #ffadad;
      background: #3a141455;
      cursor: pointer;
      transition: background 0.16s ease, transform 0.16s ease, border-color 0.16s ease;
    }
    .quick-job-delete:hover {
      background: #4d191970;
      border-color: #ff8f8f6b;
      transform: translateY(-1px);
    }
    .quick-job-delete:disabled {
      opacity: 0.65;
      cursor: wait;
      transform: none;
    }
    .quick-jobs-empty {
      padding: 8px 10px;
      border: 1px dashed #ffffff22;
      border-radius: 10px;
      color: #b8cae3;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
    }
    .quick-view-hidden {
      display: none;
    }
    .settings-btn {
      position: fixed;
      top: 52px;
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
    .repo-cta {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 5;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 0 12px;
      border-radius: 0;
      text-decoration: none;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #f1f6ff;
      background: linear-gradient(180deg, #ffffff18, #ffffff0d);
      backdrop-filter: blur(6px);
      border-bottom: 1px solid #ffffff22;
      animation: ctaEnter 420ms ease-out both;
      transition: background 0.18s ease;
    }
    .repo-cta:hover {
      background: linear-gradient(180deg, #ffffff22, #ffffff12);
    }
    .repo-text {
      opacity: 0.92;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .repo-star {
      color: #ffe08f;
      animation: starPulse 1.8s ease-in-out infinite;
    }
    @keyframes ctaEnter {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes starPulse {
      0%, 100% { opacity: 0.78; }
      50% { opacity: 1; }
    }
    .settings-modal {
      position: fixed;
      top: 94px;
      right: 18px;
      width: min(320px, calc(100vw - 36px));
      z-index: 6;
      border: 1px solid #d8e4ff20;
      border-radius: 14px;
      background: #0b1220b8;
      backdrop-filter: blur(10px);
      box-shadow: 0 18px 36px #0000005a;
      padding: 12px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(-8px) scale(0.98);
      transition: opacity 0.2s ease, transform 0.2s ease, visibility 0s linear 0.2s;
    }
    .settings-modal.open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0) scale(1);
      transition: opacity 0.2s ease, transform 0.2s ease, visibility 0s linear 0s;
    }
    .settings-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #9eb5d6;
      margin-bottom: 6px;
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
    .setting-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 2px;
      border-top: 1px solid #ffffff12;
    }
    .settings-stack {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .setting-main {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      min-width: 0;
    }
    .setting-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
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
    .settings-meta {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #9eb5d6;
      opacity: 0.9;
      letter-spacing: 0.03em;
    }
    .hb-toggle {
      border: 1px solid #ffffff2a;
      background: transparent;
      color: #dce7f8;
      border-radius: 999px;
      min-width: 92px;
      padding: 7px 10px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease, opacity 0.16s ease;
    }
    .hb-toggle:hover {
      transform: translateY(-1px);
    }
    .hb-toggle:disabled {
      cursor: wait;
      opacity: 0.72;
      transform: none;
    }
    .hb-toggle.on {
      background: #11342455;
      border-color: #67f0b560;
      color: #67f0b5;
    }
    .hb-toggle.off {
      background: #34181855;
      border-color: #ff7f7f55;
      color: #ff9b9b;
    }
    .hb-config {
      border: 1px solid #ffffff2a;
      background: #ffffff0f;
      color: #dce7f8;
      border-radius: 999px;
      min-width: 92px;
      padding: 7px 10px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
    }
    .hb-config:hover {
      transform: translateY(-1px);
      background: #ffffff1d;
      border-color: #ffffff42;
    }
    .hb-card {
      width: min(700px, 100%);
      border: 1px solid #d8e4ff20;
      border-radius: 16px;
      background: #0b1220f2;
      box-shadow: 0 20px 44px #00000066;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .hb-form {
      padding: 14px;
      display: grid;
      gap: 12px;
    }
    .hb-field {
      display: grid;
      gap: 6px;
    }
    .hb-label {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #bfd4ef;
    }
    .hb-input,
    .hb-textarea {
      width: 100%;
      border-radius: 10px;
      border: 1px solid #ffffff2e;
      background: #ffffff09;
      color: #eef4ff;
      font-family: "JetBrains Mono", monospace;
      font-size: 13px;
      padding: 10px 11px;
    }
    .hb-textarea {
      min-height: 190px;
      resize: vertical;
      line-height: 1.4;
    }
    .hb-input:focus-visible,
    .hb-textarea:focus-visible {
      outline: 1px solid #7dc5ff88;
      outline-offset: 1px;
    }
    .hb-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-top: 1px solid #ffffff12;
      padding-top: 12px;
      flex-wrap: wrap;
    }
    .hb-status {
      min-height: 1.2em;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #cde0f7;
      opacity: 0.95;
    }
    .hb-buttons {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hb-btn {
      height: 34px;
      padding: 0 14px;
      border-radius: 999px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.03em;
      cursor: pointer;
      transition: transform 0.16s ease, filter 0.16s ease, opacity 0.16s ease, background 0.16s ease, border-color 0.16s ease;
    }
    .hb-btn:hover {
      transform: translateY(-1px);
    }
    .hb-btn:disabled {
      opacity: 0.7;
      cursor: wait;
      transform: none;
      filter: none;
    }
    .hb-btn.ghost {
      border: 1px solid #ffffff2c;
      background: #ffffff10;
      color: #daebff;
    }
    .hb-btn.solid {
      border: 1px solid #3cb87980;
      background: linear-gradient(180deg, #1f6f47d4 0%, #18563ace 100%);
      color: #c8f8de;
      font-weight: 600;
    }
    .hb-btn.solid:hover {
      filter: brightness(1.06);
    }
    .info-modal {
      position: fixed;
      inset: 0;
      z-index: 7;
      display: grid;
      place-items: center;
      background: #02050db0;
      padding: 18px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.18s ease, visibility 0s linear 0.18s;
    }
    .info-modal.open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transition: opacity 0.18s ease, visibility 0s linear 0s;
    }
    .info-card {
      width: min(980px, 100%);
      max-height: min(82vh, 900px);
      border: 1px solid #d8e4ff20;
      border-radius: 16px;
      background: #0b1220f2;
      box-shadow: 0 20px 44px #00000066;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .info-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid #ffffff12;
      font-family: "JetBrains Mono", monospace;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #b8c9e5;
      font-size: 12px;
    }
    .info-body {
      padding: 10px 14px 14px;
      overflow: auto;
      display: grid;
      gap: 10px;
      scrollbar-width: thin;
      scrollbar-color: #7fa6d5 #091222;
    }
    .info-section {
      border: 1px solid #ffffff14;
      border-radius: 10px;
      overflow: visible;
      background: #0a1321;
    }
    .info-title {
      padding: 8px 10px;
      border-bottom: 1px solid #ffffff12;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #9db4d6;
    }
    .info-json {
      margin: 0;
      padding: 10px;
      max-height: none;
      min-height: 0;
      overflow: visible;
      display: block;
      white-space: pre;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      color: #d7e3f5;
      background: #060d18;
      line-height: 1.5;
      overscroll-behavior: auto;
    }
    .info-body::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    .info-body::-webkit-scrollbar-track {
      background: #091222;
      border-radius: 999px;
    }
    .info-body::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, #93c6ff, #668ebf);
      border-radius: 999px;
      border: 2px solid #091222;
    }
    .info-body::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(180deg, #a9d4ff, #789fce);
    }

    .dock-shell {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      width: min(1140px, calc(100% - 24px));
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr) 84px;
      gap: 12px;
      align-items: center;
      z-index: 2;
    }

    .dock {
      width: 100%;
      padding: 6px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 0;
      border-radius: 26px;
      border: 0;
      background: #ffffff08;
      backdrop-filter: blur(10px);
      box-shadow: none;
    }

    .pill {
      min-height: 54px;
      flex: 1 1 0;
      padding: 8px 10px;
      border-radius: 0;
      border: 0;
      border-right: 0;
      background: transparent;
      color: #e7f0ff;
      font-size: 12px;
      letter-spacing: 0.01em;
      font-family: "JetBrains Mono", monospace;
      display: grid;
      align-content: center;
      justify-items: center;
      gap: 3px;
    }
    .pill:last-child {
      border-right: 0;
    }
    .side-bubble {
      width: 74px;
      height: 74px;
      border-radius: 999px;
      background: #ffffff08;
      backdrop-filter: blur(10px);
      display: grid;
      place-items: center;
      text-align: center;
      font-family: "JetBrains Mono", monospace;
      color: #eef4ff;
      line-height: 1.1;
      padding: 8px;
    }
    .side-icon {
      font-size: 13px;
      opacity: 0.85;
    }
    .side-value {
      font-size: 13px;
      font-weight: 600;
      margin-top: 2px;
    }
    .side-label {
      font-size: 10px;
      opacity: 0.75;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 2px;
    }
    .pill-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #d6e2f5;
      opacity: 0.75;
    }
    .pill-icon {
      width: 14px;
      min-width: 14px;
      text-align: center;
      font-size: 11px;
      line-height: 1;
      opacity: 0.9;
    }
    .pill-value {
      font-size: 12px;
      color: #f3f7ff;
      font-weight: 500;
      text-shadow: none;
    }

    .pill.ok { border-color: #67f0b542; }
    .pill.ok .pill-value { color: #8bf7c6; }
    .pill.warn { border-color: #ffc27652; }
    .pill.warn .pill-value { color: #ffd298; }
    .pill.bad { border-color: #ff7f7f47; }
    .pill.bad .pill-value { color: #ffacac; }

    @media (max-width: 640px) {
      .stage {
        padding-top: 50px;
        padding-bottom: 160px;
      }
      .repo-cta {
        font-size: 10px;
        height: 30px;
        gap: 7px;
      }
      .settings-btn {
        top: 42px;
      }
      .quick-job {
        margin-top: 14px;
        padding: 11px;
      }
      .quick-job-head-row {
        flex-direction: column;
      }
      .quick-job-grid,
      .quick-job-actions {
        grid-template-columns: 1fr;
      }
      .dock-shell {
        bottom: 14px;
        width: min(980px, calc(100% - 12px));
        grid-template-columns: 62px minmax(0, 1fr) 62px;
        gap: 8px;
      }
      .dock {
        border-radius: 18px;
        flex-wrap: wrap;
        gap: 4px 0;
      }
      .pill {
        font-size: 11px;
        min-height: 50px;
        flex: 1 1 50%;
        border-right: 0;
        border-bottom: 0;
      }
      .side-bubble {
        width: 62px;
        height: 62px;
        padding: 6px;
      }
      .side-value {
        font-size: 12px;
      }
      .side-label {
        font-size: 9px;
      }
      .pill:last-child,
      .pill:nth-last-child(2) {
        border-bottom: 0;
      }
    }

/* ── Tab nav ── */
[hidden] { display: none !important; }
.tab-nav {
  display: flex;
  gap: 4px;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.08));
  margin-bottom: 0;
}
.tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--fg-3, #888);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.03em;
  padding: 6px 14px 10px;
  transition: color 0.15s, border-color 0.15s;
}
.tab-btn:hover { color: var(--fg-1, #eee); }
.tab-btn-active {
  border-bottom-color: var(--accent, #4a9eff);
  color: var(--fg-1, #eee);
}

/* ── Kanban board ── */
.kanban-board {
  display: flex;
  gap: 0;
  height: calc(100vh - 200px);
  overflow: hidden;
}
.kanban-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(255,255,255,0.06);
  overflow: hidden;
}
.kanban-col:last-child { border-right: none; }
.kanban-col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 10px;
  flex-shrink: 0;
}
.kanban-col-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kanban-col-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.kanban-indicator-todo { background: #a855f7; }
.kanban-indicator-inprogress { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
.kanban-indicator-done { background: #22c55e; }
.kanban-col-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.5);
}
.kanban-col-count {
  font-size: 11px;
  font-weight: 600;
  background: rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 1px 7px;
  color: rgba(255,255,255,0.4);
}
.kanban-clear-btn {
  background: none;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px;
  color: rgba(255,255,255,0.35);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 8px;
}
.kanban-clear-btn:hover { color: rgba(255,255,255,0.7); border-color: rgba(255,255,255,0.25); }
.kanban-cards {
  flex: 1;
  overflow-y: auto;
  padding: 8px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kanban-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 10px 12px;
  cursor: default;
  transition: background 0.15s;
}
.kanban-card:hover { background: rgba(255,255,255,0.07); }
.kanban-card-title {
  font-size: 13px;
  font-weight: 500;
  color: rgba(255,255,255,0.85);
  margin-bottom: 3px;
}
.kanban-card-desc {
  font-size: 12px;
  color: rgba(255,255,255,0.4);
  margin-bottom: 5px;
  line-height: 1.4;
}
.kanban-card-meta {
  font-size: 11px;
  color: rgba(255,255,255,0.3);
  font-family: "JetBrains Mono", monospace;
}
.kanban-empty {
  color: rgba(255,255,255,0.2);
  font-size: 12px;
  text-align: center;
  padding: 24px 0;
}
.kanban-toolbar {
  padding: 10px 18px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
.kanban-add-btn {
  background: rgba(74,158,255,0.1);
  border: 1px solid rgba(74,158,255,0.25);
  border-radius: 7px;
  color: rgba(74,158,255,0.9);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 16px;
  transition: background 0.15s;
}
.kanban-add-btn:hover { background: rgba(74,158,255,0.18); }
/* Kanban modal */
.kanban-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.kanban-modal {
  background: #1a1a1f;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  min-width: 360px;
  max-width: 480px;
  width: 100%;
}
.kanban-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  font-weight: 600;
  font-size: 14px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.kanban-modal-close {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
}
.kanban-modal-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.kanban-input {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 7px;
  color: rgba(255,255,255,0.85);
  font-family: inherit;
  font-size: 13px;
  padding: 9px 12px;
  width: 100%;
  resize: none;
}
.kanban-input:focus { outline: none; border-color: rgba(74,158,255,0.4); }
.kanban-textarea { min-height: 70px; }
.kanban-modal-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 20px 16px;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.kanban-btn-primary {
  background: rgba(74,158,255,0.15);
  border: 1px solid rgba(74,158,255,0.3);
  border-radius: 7px;
  color: rgba(74,158,255,0.95);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 16px;
}
.kanban-btn-primary:hover { background: rgba(74,158,255,0.25); }
.kanban-btn-secondary {
  background: none;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 7px;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 13px;
  padding: 7px 16px;
}
.kanban-btn-secondary:hover { color: rgba(255,255,255,0.7); }`;
