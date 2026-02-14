export const pageScript = String.raw`    const $ = (id) => document.getElementById(id);

    const clockEl = $("clock");
    const dateEl = $("date");
    const msgEl = $("message");
    const dockEl = $("dock");
    const typewriterEl = $("typewriter");
    const settingsBtn = $("settings-btn");
    const settingsModal = $("settings-modal");
    const settingsClose = $("settings-close");
    const infoOpen = $("info-open");
    const infoModal = $("info-modal");
    const infoClose = $("info-close");
    const infoBody = $("info-body");
    const hbToggle = $("hb-toggle");
    const clockToggle = $("clock-toggle");
    const hbInfoEl = $("hb-info");
    const clockInfoEl = $("clock-info");
    const quickJobsView = $("quick-jobs-view");
    const quickJobForm = $("quick-job-form");
    const quickOpenCreate = $("quick-open-create");
    const quickBackJobs = $("quick-back-jobs");
    const quickJobOffset = $("quick-job-offset");
    const quickJobPrompt = $("quick-job-prompt");
    const quickJobSubmit = $("quick-job-submit");
    const quickJobStatus = $("quick-job-status");
    const quickJobPreview = $("quick-job-preview");
    const quickJobCount = $("quick-job-count");
    const quickJobsList = $("quick-jobs-list");
    const jobsBubbleEl = $("jobs-bubble");
    const uptimeBubbleEl = $("uptime-bubble");
    let hbBusy = false;
    let use12Hour = localStorage.getItem("clock.format") === "12";
    let quickView = "jobs";
    let quickViewInitialized = false;
    let scrollAnimFrame = 0;

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
      "Okay human, let's do it faster.",
      "Build. Refine. Ship.",
      "Keep it simple. Keep it clean.",
      "One focused step at a time.",
      "Clock is live. Let's move.",
      "Ship it, lobster mode.",
      "Precision first.",
      "No excuses, only commits."
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

      if (state.heartbeat.enabled) {
        pills.push({
          cls: "ok",
          icon: "💓",
          label: "Heartbeat",
          value: "Every " + state.heartbeat.intervalMinutes + "m",
        });
      } else {
        pills.push({
          cls: "bad",
          icon: "💓",
          label: "Heartbeat",
          value: "Disabled",
        });
      }

      pills.push({
        cls: state.security.level === "unrestricted" ? "warn" : "ok",
        icon: "🛡️",
        label: "Security",
        value: cap(state.security.level),
      });

      pills.push({
        cls: state.telegram.configured ? "ok" : "warn",
        icon: "✈️",
        label: "Telegram",
        value: state.telegram.configured
          ? (state.telegram.allowedUserCount + " user" + (state.telegram.allowedUserCount !== 1 ? "s" : ""))
          : "Not configured",
      });

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

    function clockFromSchedule(schedule) {
      const parts = String(schedule || "").trim().split(/\s+/);
      if (parts.length < 2) return schedule;
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return schedule;
      }
      const dt = new Date();
      dt.setHours(hour, minute, 0, 0);
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: use12Hour,
      }).format(dt);
    }

    function renderJobsList(jobs) {
      if (!quickJobsList) return;
      const items = Array.isArray(jobs) ? jobs.slice() : [];
      if (!items.length) {
        quickJobsList.innerHTML = '<div class="quick-jobs-empty">No jobs yet.</div>';
        return;
      }
      quickJobsList.innerHTML = items
        .slice(-8)
        .reverse()
        .map((j) =>
          '<div class="quick-job-item">' +
            '<div class="quick-job-item-time">' + esc(clockFromSchedule(j.schedule || "")) + "</div>" +
            '<div class="quick-job-item-name">' + esc(j.name || "job") + "</div>" +
          "</div>"
        )
        .join("");
    }

    function smoothScrollTo(top) {
      if (scrollAnimFrame) cancelAnimationFrame(scrollAnimFrame);
      const start = window.scrollY;
      const target = Math.max(0, top);
      const distance = target - start;
      if (Math.abs(distance) < 1) return;
      const duration = 560;
      const t0 = performance.now();

      const step = (now) => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        window.scrollTo(0, start + distance * eased);
        if (p < 1) {
          scrollAnimFrame = requestAnimationFrame(step);
        } else {
          scrollAnimFrame = 0;
        }
      };

      scrollAnimFrame = requestAnimationFrame(step);
    }

    function focusQuickView(view) {
      const target = view === "jobs" ? quickJobsView : quickJobForm;
      if (!target) return;
      const y = Math.max(0, window.scrollY + target.getBoundingClientRect().top - 44);
      smoothScrollTo(y);
    }

    function setQuickView(view, options) {
      if (!quickJobsView || !quickJobForm) return;
      const showJobs = view === "jobs";
      quickJobsView.classList.toggle("quick-view-hidden", !showJobs);
      quickJobForm.classList.toggle("quick-view-hidden", showJobs);
      quickView = showJobs ? "jobs" : "create";
      if (options && options.scroll) focusQuickView(quickView);
    }

    function syncQuickViewForJobs(jobs) {
      const count = Array.isArray(jobs) ? jobs.length : 0;
      if (count === 0) {
        setQuickView("create");
        quickViewInitialized = true;
        return;
      }
      if (!quickViewInitialized) {
        setQuickView("jobs");
        quickViewInitialized = true;
      }
    }

    async function refreshState() {
      try {
        const res = await fetch("/api/state");
        const state = await res.json();
        const pills = buildPills(state);
        dockEl.innerHTML = pills.map((p) =>
          '<div class="pill ' + p.cls + '">' +
            '<div class="pill-label"><span class="pill-icon">' + esc(p.icon || "") + "</span>" + esc(p.label) + '</div>' +
            '<div class="pill-value">' + esc(p.value) + '</div>' +
          "</div>"
        ).join("");
        if (jobsBubbleEl) {
          jobsBubbleEl.innerHTML =
            '<div class="side-icon">🗂️</div>' +
            '<div class="side-value">' + esc(String(state.jobs?.length ?? 0)) + "</div>" +
            '<div class="side-label">Jobs</div>';
        }
        renderJobsList(state.jobs);
        syncQuickViewForJobs(state.jobs);
        if (uptimeBubbleEl) {
          uptimeBubbleEl.innerHTML =
            '<div class="side-icon">⏱️</div>' +
            '<div class="side-value">' + esc(fmtDur(state.daemon?.uptimeMs ?? 0)) + "</div>" +
            '<div class="side-label">Uptime</div>';
        }
      } catch (err) {
        dockEl.innerHTML = '<div class="pill bad"><div class="pill-label"><span class="pill-icon">⚠️</span>Status</div><div class="pill-value">Offline</div></div>';
        if (jobsBubbleEl) {
          jobsBubbleEl.innerHTML = '<div class="side-icon">🗂️</div><div class="side-value">-</div><div class="side-label">Jobs</div>';
        }
        renderJobsList([]);
        syncQuickViewForJobs([]);
        if (uptimeBubbleEl) {
          uptimeBubbleEl.innerHTML = '<div class="side-icon">⏱️</div><div class="side-value">-</div><div class="side-label">Uptime</div>';
        }
      }
    }

    function cap(s) {
      if (!s) return "";
      return s.slice(0, 1).toUpperCase() + s.slice(1);
    }

    async function loadSettings() {
      if (!hbToggle) return;
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        const on = Boolean(data?.heartbeat?.enabled);
        const intervalMinutes = Number(data?.heartbeat?.interval) || 15;
        setHeartbeatUi(on, undefined, intervalMinutes);
      } catch (err) {
        hbToggle.textContent = "Error";
        hbToggle.className = "hb-toggle off";
        if (hbInfoEl) hbInfoEl.textContent = "unavailable";
      }
    }

    async function openTechnicalInfo() {
      if (!infoModal || !infoBody) return;
      infoModal.classList.add("open");
      infoModal.setAttribute("aria-hidden", "false");
      infoBody.innerHTML = '<div class="info-section"><div class="info-title">Loading</div><pre class="info-json">Loading technical data...</pre></div>';
      try {
        const res = await fetch("/api/technical-info");
        const data = await res.json();
        renderTechnicalInfo(data);
      } catch (err) {
        infoBody.innerHTML = '<div class="info-section"><div class="info-title">Error</div><pre class="info-json">' + esc(String(err)) + "</pre></div>";
      }
    }

    function renderTechnicalInfo(data) {
      if (!infoBody) return;
      const sections = [
        { title: "daemon", value: data?.daemon ?? null },
        { title: "settings.json", value: data?.files?.settingsJson ?? null },
        { title: "session.json", value: data?.files?.sessionJson ?? null },
        { title: "state.json", value: data?.files?.stateJson ?? null },
      ];
      infoBody.innerHTML = sections.map((section) =>
        '<div class="info-section">' +
          '<div class="info-title">' + esc(section.title) + "</div>" +
          '<pre class="info-json">' + esc(JSON.stringify(section.value, null, 2)) + "</pre>" +
        "</div>"
      ).join("");
    }

    function setHeartbeatUi(on, label, intervalMinutes) {
      if (!hbToggle) return;
      hbToggle.textContent = label || (on ? "Enabled" : "Disabled");
      hbToggle.className = "hb-toggle " + (on ? "on" : "off");
      hbToggle.dataset.enabled = on ? "1" : "0";
      if (intervalMinutes != null) hbToggle.dataset.interval = String(intervalMinutes);
      const iv = Number(hbToggle.dataset.interval) || 15;
      if (hbInfoEl) hbInfoEl.textContent = on ? ("every " + iv + " minutes") : ("paused (interval " + iv + "m)");
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
    if (infoOpen) {
      infoOpen.addEventListener("click", openTechnicalInfo);
    }
    if (infoClose && infoModal) {
      infoClose.addEventListener("click", () => {
        infoModal.classList.remove("open");
        infoModal.setAttribute("aria-hidden", "true");
      });
    }
    document.addEventListener("click", (event) => {
      if (!settingsModal || !settingsBtn) return;
      if (!settingsModal.classList.contains("open")) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (settingsModal.contains(target) || settingsBtn.contains(target)) return;
      settingsModal.classList.remove("open");
    });
    document.addEventListener("click", (event) => {
      if (!infoModal) return;
      if (!infoModal.classList.contains("open")) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target === infoModal) {
        infoModal.classList.remove("open");
        infoModal.setAttribute("aria-hidden", "true");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (infoModal && infoModal.classList.contains("open")) {
        infoModal.classList.remove("open");
        infoModal.setAttribute("aria-hidden", "true");
      } else if (settingsModal && settingsModal.classList.contains("open")) {
        settingsModal.classList.remove("open");
      }
    });

    if (hbToggle) {
      hbToggle.addEventListener("click", async () => {
        if (hbBusy) return;
        const current = hbToggle.dataset.enabled === "1";
        const intervalMinutes = Number(hbToggle.dataset.interval) || 15;
        const next = !current;
        hbBusy = true;
        hbToggle.disabled = true;
        setHeartbeatUi(next, next ? "Enabled" : "Disabled", intervalMinutes);
        try {
          const res = await fetch("/api/settings/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "save failed");
          await refreshState();
        } catch {
          setHeartbeatUi(current, current ? "Enabled" : "Disabled", intervalMinutes);
        } finally {
          hbBusy = false;
          hbToggle.disabled = false;
        }
      });
    }

    function renderClockToggle() {
      if (!clockToggle) return;
      clockToggle.textContent = use12Hour ? "12h" : "24h";
      clockToggle.className = "hb-toggle " + (use12Hour ? "on" : "off");
      if (clockInfoEl) clockInfoEl.textContent = use12Hour ? "12-hour format" : "24-hour format";
    }

    if (clockToggle) {
      renderClockToggle();
      clockToggle.addEventListener("click", () => {
        use12Hour = !use12Hour;
        localStorage.setItem("clock.format", use12Hour ? "12" : "24");
        renderClockToggle();
        renderClock();
        updateQuickJobUi();
      });
    }

    if (quickJobOffset && !quickJobOffset.value) {
      quickJobOffset.value = "60";
    }

    function normalizeOffsetMinutes(value) {
      const n = Number(String(value || "").trim());
      if (!Number.isFinite(n)) return null;
      const rounded = Math.round(n);
      if (rounded < 1 || rounded > 1440) return null;
      return rounded;
    }

    function computeTimeFromOffset(offsetMinutes) {
      const dt = new Date(Date.now() + offsetMinutes * 60_000);
      const hour = dt.getHours();
      const minute = dt.getMinutes();
      const time = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
      const dayLabel = dt.toDateString() === new Date().toDateString() ? "Today" : "Tomorrow";
      const human = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: use12Hour,
      }).format(dt);
      return { hour, minute, time, dayLabel, human };
    }

    function formatPreviewTime(hour, minute) {
      const dt = new Date();
      dt.setHours(hour, minute, 0, 0);
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: use12Hour,
      }).format(dt);
    }

    function updateQuickJobUi() {
      if (quickJobPrompt && quickJobCount) {
        const count = (quickJobPrompt.value || "").trim().length;
        quickJobCount.textContent = String(count) + " chars";
      }
      if (quickJobOffset && quickJobPreview) {
        const offset = normalizeOffsetMinutes(quickJobOffset.value || "");
        if (!offset) {
          quickJobPreview.textContent = "Use 1-1440 minutes";
          quickJobPreview.style.color = "#ffd39f";
          return;
        }
        const target = computeTimeFromOffset(offset);
        const human = formatPreviewTime(target.hour, target.minute) || target.time;
        quickJobPreview.textContent = target.dayLabel + " " + human;
        quickJobPreview.style.color = "#a8f1ca";
      }
    }

    if (quickJobOffset) quickJobOffset.addEventListener("input", updateQuickJobUi);
    if (quickJobPrompt) quickJobPrompt.addEventListener("input", updateQuickJobUi);

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const add = target.closest("[data-add-minutes]");
      if (!add || !(add instanceof HTMLElement)) return;
      if (!quickJobOffset) return;
      const delta = Number(add.getAttribute("data-add-minutes") || "");
      if (!Number.isFinite(delta)) return;
      const current = normalizeOffsetMinutes(quickJobOffset.value) || 60;
      const next = Math.min(1440, current + Math.round(delta));
      quickJobOffset.value = String(next);
      updateQuickJobUi();
    });

    if (quickOpenCreate) {
      quickOpenCreate.addEventListener("click", () => setQuickView("create", { scroll: true }));
    }

    if (quickBackJobs) {
      quickBackJobs.addEventListener("click", () => setQuickView("jobs", { scroll: true }));
    }

    if (quickJobForm && quickJobOffset && quickJobPrompt && quickJobSubmit && quickJobStatus) {
      quickJobForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const offset = normalizeOffsetMinutes(quickJobOffset.value || "");
        const prompt = (quickJobPrompt.value || "").trim();
        if (!offset || !prompt) {
          quickJobStatus.textContent = "Use 1-1440 minutes and add a prompt.";
          return;
        }
        const target = computeTimeFromOffset(offset);
        quickJobSubmit.disabled = true;
        quickJobStatus.textContent = "Saving job...";
        try {
          const res = await fetch("/api/jobs/quick", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ time: target.time, prompt }),
          });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "failed");
          quickJobStatus.textContent = "Added to jobs list.";
          quickJobPrompt.value = "";
          updateQuickJobUi();
          setQuickView("jobs", { scroll: true });
          await refreshState();
        } catch (err) {
          quickJobStatus.textContent = "Failed: " + String(err instanceof Error ? err.message : err);
        } finally {
          quickJobSubmit.disabled = false;
        }
      });
    }

    function esc(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    renderClock();
    setInterval(renderClock, 1000);
    startTypewriter();
    updateQuickJobUi();
    setQuickView(quickView);

    refreshState();
    setInterval(refreshState, 1000);`;
