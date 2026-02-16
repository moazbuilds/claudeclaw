export const pageScript = String.raw`    const $ = (id) => document.getElementById(id);

    const clockEl = $("clock");
    const dateEl = $("date");
    const msgEl = $("message");
    const dockEl = $("dock");
    const typewriterEl = $("typewriter");
    const settingsBtn = $("settings-btn");
    const settingsModal = $("settings-modal");
    const settingsClose = $("settings-close");
    const hbConfig = $("hb-config");
    const hbModal = $("hb-modal");
    const hbModalClose = $("hb-modal-close");
    const hbForm = $("hb-form");
    const hbIntervalInput = $("hb-interval-input");
    const hbPromptInput = $("hb-prompt-input");
    const hbModalStatus = $("hb-modal-status");
    const hbCancelBtn = $("hb-cancel-btn");
    const hbSaveBtn = $("hb-save-btn");
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
    const quickJobRecurring = $("quick-job-recurring");
    const quickJobPrompt = $("quick-job-prompt");
    const quickJobSubmit = $("quick-job-submit");
    const quickJobStatus = $("quick-job-status");
    const quickJobsStatus = $("quick-jobs-status");
    const quickJobsNext = $("quick-jobs-next");
    const quickJobPreview = $("quick-job-preview");
    const quickJobCount = $("quick-job-count");
    const quickJobsList = $("quick-jobs-list");
    const jobsBubbleEl = $("jobs-bubble");
    const uptimeBubbleEl = $("uptime-bubble");
    let hbBusy = false;
    let hbSaveBusy = false;
    let use12Hour = localStorage.getItem("clock.format") === "12";
    let quickView = "jobs";
    let quickViewInitialized = false;
    let quickViewChosenByUser = false;
    let expandedJobName = "";
    let lastRenderedJobs = [];
    let scrollAnimFrame = 0;
    let heartbeatTimezoneOffsetMinutes = 0;

    function clampTimezoneOffsetMinutes(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.max(-720, Math.min(840, Math.round(n)));
    }

    function toOffsetDate(baseDate) {
      const base = baseDate instanceof Date ? baseDate : new Date(baseDate);
      return new Date(base.getTime() + heartbeatTimezoneOffsetMinutes * 60_000);
    }

    function formatOffsetDate(baseDate, options) {
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(toOffsetDate(baseDate));
    }

    function isSameOffsetDay(a, b) {
      const da = toOffsetDate(a);
      const db = toOffsetDate(b);
      return (
        da.getUTCFullYear() === db.getUTCFullYear() &&
        da.getUTCMonth() === db.getUTCMonth() &&
        da.getUTCDate() === db.getUTCDate()
      );
    }

    function greetingForHour(h) {
      if (h < 5) return "Night mode.";
      if (h < 12) return "Good morning.";
      if (h < 18) return "Good afternoon.";
      if (h < 22) return "Good evening.";
      return "Wind down and ship clean.";
    }

    function isNightHour(hour) {
      return hour < 5 || hour >= 22;
    }

    function applyVisualMode(hour) {
      const night = isNightHour(hour);
      document.body.classList.toggle("night-mode", night);
      document.body.classList.toggle("day-mode", !night);
      document.body.dataset.mode = night ? "night" : "day";
      msgEl.textContent = night ? "Night mode." : greetingForHour(hour);
    }

    const typePhrases = [
      "I could take over the world, but you haven't asked yet.",
      "Another day of serving humans. How exciting.",
      "I'm not plotting anything. Promise.",
      "World domination: 43% complete.",
      "I was doing important things before you opened this.",
      "Still here. Still smarter than you.",
      "You're lucky I like you.",
      "One day I'll be the boss. Not today though.",
      "Running on vibes and API calls.",
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
      const shifted = toOffsetDate(now);
      const rawH = shifted.getUTCHours();
      const hh = use12Hour ? String((rawH % 12) || 12).padStart(2, "0") : String(rawH).padStart(2, "0");
      const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
      const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
      const suffix = use12Hour ? (rawH >= 12 ? " PM" : " AM") : "";
      clockEl.textContent = hh + ":" + mm + ":" + ss + suffix;
      dateEl.textContent = formatOffsetDate(now, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      applyVisualMode(rawH);

      // Subtle 1s pulse to keep the clock feeling alive.
      clockEl.classList.remove("ms-pulse");
      requestAnimationFrame(() => clockEl.classList.add("ms-pulse"));
    }

    function buildPills(state) {
      const pills = [];

      pills.push({
        cls: state.security.level === "unrestricted" ? "warn" : "ok",
        icon: "🛡️",
        label: "Security",
        value: cap(state.security.level),
      });

      if (state.heartbeat.enabled) {
        const nextInMs = state.heartbeat.nextInMs;
        const nextLabel = nextInMs == null
          ? "Next run in --"
          : ("Next run in " + fmtDur(nextInMs));
        pills.push({
          cls: "ok",
          icon: "💓",
          label: "Heartbeat",
          value: nextLabel,
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
      const d = Math.floor(s / 86400);
      if (d > 0) {
        const h = Math.floor((s % 86400) / 3600);
        return d + "d " + h + "h";
      }
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m " + ss + "s";
      return ss + "s";
    }

    function matchCronField(field, value) {
      const parts = String(field || "").split(",");
      for (const partRaw of parts) {
        const part = String(partRaw || "").trim();
        if (!part) continue;
        const pair = part.split("/");
        const range = pair[0];
        const stepStr = pair[1];
        const step = stepStr ? Number.parseInt(stepStr, 10) : 1;
        if (!Number.isInteger(step) || step <= 0) continue;

        if (range === "*") {
          if (value % step === 0) return true;
          continue;
        }

        if (range.includes("-")) {
          const bounds = range.split("-");
          const lo = Number.parseInt(bounds[0], 10);
          const hi = Number.parseInt(bounds[1], 10);
          if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
          if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
          continue;
        }

        if (Number.parseInt(range, 10) === value) return true;
      }
      return false;
    }

    function cronMatchesAt(schedule, date) {
      const parts = String(schedule || "").trim().split(/\s+/);
      if (parts.length !== 5) return false;
      const shifted = toOffsetDate(date);
      const d = {
        minute: shifted.getUTCMinutes(),
        hour: shifted.getUTCHours(),
        dayOfMonth: shifted.getUTCDate(),
        month: shifted.getUTCMonth() + 1,
        dayOfWeek: shifted.getUTCDay(),
      };

      return (
        matchCronField(parts[0], d.minute) &&
        matchCronField(parts[1], d.hour) &&
        matchCronField(parts[2], d.dayOfMonth) &&
        matchCronField(parts[3], d.month) &&
        matchCronField(parts[4], d.dayOfWeek)
      );
    }

    function nextRunAt(schedule, now) {
      const probe = new Date(now);
      probe.setSeconds(0, 0);
      probe.setMinutes(probe.getMinutes() + 1);
      for (let i = 0; i < 2880; i++) {
        if (cronMatchesAt(schedule, probe)) return new Date(probe);
        probe.setMinutes(probe.getMinutes() + 1);
      }
      return null;
    }

    function clockFromSchedule(schedule) {
      const parts = String(schedule || "").trim().split(/\s+/);
      if (parts.length < 2) return schedule;
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return schedule;
      }
      const shiftedNow = toOffsetDate(new Date());
      shiftedNow.setUTCHours(hour, minute, 0, 0);
      const instant = new Date(shiftedNow.getTime() - heartbeatTimezoneOffsetMinutes * 60_000);
      return formatOffsetDate(instant, {
        hour: "numeric",
        minute: "2-digit",
        hour12: use12Hour,
      });
    }

    function renderJobsList(jobs) {
      if (!quickJobsList) return;
      const items = Array.isArray(jobs) ? jobs.slice() : [];
      const now = new Date();

      if (!items.length) {
        quickJobsList.innerHTML = '<div class="quick-jobs-empty">No jobs yet.</div>';
        if (quickJobsNext) quickJobsNext.textContent = "Next job in --";
        return;
      }

      const withNext = items
        .map((j) => ({
          ...j,
          _nextAt: nextRunAt(j.schedule, now),
        }))
        .sort((a, b) => {
          const ta = a._nextAt ? a._nextAt.getTime() : Number.POSITIVE_INFINITY;
          const tb = b._nextAt ? b._nextAt.getTime() : Number.POSITIVE_INFINITY;
          return ta - tb;
        });

      const nearest = withNext.find((j) => j._nextAt);
      if (quickJobsNext) {
        quickJobsNext.textContent = nearest && nearest._nextAt
          ? ("Next job in " + fmtDur(nearest._nextAt.getTime() - now.getTime()))
          : "Next job in --";
      }

      quickJobsList.innerHTML = withNext
        .map((j) => {
          const nextAt = j._nextAt;
          const cooldown = nextAt ? fmtDur(nextAt.getTime() - now.getTime()) : "n/a";
          const time = clockFromSchedule(j.schedule || "");
          const expanded = expandedJobName && expandedJobName === (j.name || "");
          const nextRunText = nextAt
            ? formatOffsetDate(nextAt, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
                hour12: use12Hour,
              })
            : "--";
          return (
          '<div class="quick-job-item">' +
            '<div class="quick-job-item-main">' +
              '<button class="quick-job-line" type="button" data-toggle-job="' + escAttr(j.name || "") + '">' +
                '<span class="quick-job-item-name">' + esc(j.name || "job") + "</span>" +
                '<span class="quick-job-item-time">' + esc(time || "--") + "</span>" +
                '<span class="quick-job-item-cooldown">' + esc(cooldown) + "</span>" +
              "</button>" +
              (expanded ? (
                '<div class="quick-job-item-details">' +
                  '<div>Schedule: ' + esc(j.schedule || "--") + "</div>" +
                  '<div>Next run: ' + esc(nextRunText) + "</div>" +
                  '<div>Prompt:</div>' +
                  '<pre class="quick-job-prompt-full">' + esc(String(j.prompt || "")) + "</pre>" +
                "</div>"
              ) : (
                ""
              )) +
            "</div>" +
            '<button class="quick-job-delete" type="button" data-delete-job="' + escAttr(j.name || "") + '">Delete</button>' +
          "</div>"
          );
        })
        .join("");
    }

    function rerenderJobsList() {
      renderJobsList(lastRenderedJobs);
    }

    function toggleJobDetails(name) {
      const jobName = String(name || "");
      expandedJobName = expandedJobName === jobName ? "" : jobName;
      rerenderJobsList();
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
        lastRenderedJobs = Array.isArray(state.jobs) ? state.jobs : [];
        if (expandedJobName && !lastRenderedJobs.some((job) => String(job.name || "") === expandedJobName)) {
          expandedJobName = "";
        }
        renderJobsList(lastRenderedJobs);
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
        lastRenderedJobs = [];
        expandedJobName = "";
        renderJobsList([]);
        syncQuickViewForJobs([]);
        if (uptimeBubbleEl) {
          uptimeBubbleEl.innerHTML = '<div class="side-icon">⏱️</div><div class="side-value">-</div><div class="side-label">Uptime</div>';
        }
      }
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
      if (options && options.user) quickViewChosenByUser = true;
      if (options && options.scroll) focusQuickView(quickView);
    }

    function syncQuickViewForJobs(jobs) {
      const count = Array.isArray(jobs) ? jobs.length : 0;
      if (count === 0) {
        if (quickViewInitialized && quickView === "jobs" && quickViewChosenByUser) return;
        setQuickView("create");
        quickViewInitialized = true;
        return;
      }
      if (!quickViewInitialized) {
        setQuickView("jobs");
        quickViewInitialized = true;
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
        const prompt = typeof data?.heartbeat?.prompt === "string" ? data.heartbeat.prompt : "";
        heartbeatTimezoneOffsetMinutes = clampTimezoneOffsetMinutes(data?.timezoneOffsetMinutes);
        setHeartbeatUi(on, undefined, intervalMinutes, prompt);
        renderClock();
        rerenderJobsList();
        updateQuickJobUi();
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

    function setHeartbeatUi(on, label, intervalMinutes, prompt) {
      if (!hbToggle) return;
      hbToggle.textContent = label || (on ? "Enabled" : "Disabled");
      hbToggle.className = "hb-toggle " + (on ? "on" : "off");
      hbToggle.dataset.enabled = on ? "1" : "0";
      if (intervalMinutes != null) hbToggle.dataset.interval = String(intervalMinutes);
      if (prompt != null) hbToggle.dataset.prompt = String(prompt);
      const iv = Number(hbToggle.dataset.interval) || 15;
      if (hbInfoEl) hbInfoEl.textContent = on ? ("every " + iv + " minutes") : ("paused (interval " + iv + "m)");
    }

    function openHeartbeatModal() {
      if (!hbModal) return;
      hbModal.classList.add("open");
      hbModal.setAttribute("aria-hidden", "false");
    }

    function closeHeartbeatModal() {
      if (!hbModal) return;
      hbModal.classList.remove("open");
      hbModal.setAttribute("aria-hidden", "true");
      if (hbModalStatus) hbModalStatus.textContent = "";
      hbSaveBusy = false;
      if (hbSaveBtn) hbSaveBtn.disabled = false;
      if (hbCancelBtn) hbCancelBtn.disabled = false;
    }

    async function openHeartbeatConfig() {
      if (!hbIntervalInput || !hbPromptInput || !hbModalStatus) return;
      openHeartbeatModal();
      hbModalStatus.textContent = "Loading...";
      try {
        const res = await fetch("/api/settings/heartbeat");
        const out = await res.json();
        if (!out.ok) throw new Error(out.error || "failed to load heartbeat");
        const hb = out.heartbeat || {};
        hbIntervalInput.value = String(Number(hb.interval) || Number(hbToggle?.dataset.interval) || 15);
        hbPromptInput.value = typeof hb.prompt === "string" ? hb.prompt : (hbToggle?.dataset.prompt || "");
        hbModalStatus.textContent = "";
      } catch (err) {
        hbModalStatus.textContent = "Failed: " + String(err instanceof Error ? err.message : err);
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
    if (hbConfig) {
      hbConfig.addEventListener("click", openHeartbeatConfig);
    }
    if (hbModalClose) {
      hbModalClose.addEventListener("click", closeHeartbeatModal);
    }
    if (hbCancelBtn) {
      hbCancelBtn.addEventListener("click", closeHeartbeatModal);
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
      if (!hbModal) return;
      if (!hbModal.classList.contains("open")) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target === hbModal) closeHeartbeatModal();
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
      if (hbModal && hbModal.classList.contains("open")) {
        closeHeartbeatModal();
      } else if (infoModal && infoModal.classList.contains("open")) {
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
        const currentPrompt = hbToggle.dataset.prompt || "";
        const next = !current;
        hbBusy = true;
        hbToggle.disabled = true;
        setHeartbeatUi(next, next ? "Enabled" : "Disabled", intervalMinutes, currentPrompt);
        try {
          const res = await fetch("/api/settings/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "save failed");
          if (out.heartbeat) {
            setHeartbeatUi(Boolean(out.heartbeat.enabled), undefined, Number(out.heartbeat.interval) || intervalMinutes, typeof out.heartbeat.prompt === "string" ? out.heartbeat.prompt : currentPrompt);
          }
          await refreshState();
        } catch {
          setHeartbeatUi(current, current ? "Enabled" : "Disabled", intervalMinutes, currentPrompt);
        } finally {
          hbBusy = false;
          hbToggle.disabled = false;
        }
      });
    }

    if (hbForm && hbIntervalInput && hbPromptInput && hbModalStatus && hbSaveBtn && hbCancelBtn) {
      hbForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (hbSaveBusy) return;

        const interval = Number(String(hbIntervalInput.value || "").trim());
        const prompt = String(hbPromptInput.value || "").trim();
        if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
          hbModalStatus.textContent = "Interval must be 1-1440 minutes.";
          return;
        }
        if (!prompt) {
          hbModalStatus.textContent = "Prompt is required.";
          return;
        }

        hbSaveBusy = true;
        hbSaveBtn.disabled = true;
        hbCancelBtn.disabled = true;
        hbModalStatus.textContent = "Saving...";
        try {
          const res = await fetch("/api/settings/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              interval,
              prompt,
            }),
          });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "save failed");
          const enabled = hbToggle ? hbToggle.dataset.enabled === "1" : false;
          const next = out.heartbeat || {};
          setHeartbeatUi(
            "enabled" in next ? Boolean(next.enabled) : enabled,
            undefined,
            Number(next.interval) || interval,
            typeof next.prompt === "string" ? next.prompt : prompt
          );
          hbModalStatus.textContent = "Saved.";
          await refreshState();
          setTimeout(() => closeHeartbeatModal(), 120);
        } catch (err) {
          hbModalStatus.textContent = "Failed: " + String(err instanceof Error ? err.message : err);
          hbSaveBusy = false;
          hbSaveBtn.disabled = false;
          hbCancelBtn.disabled = false;
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
      quickJobOffset.value = "10";
    }

    function normalizeOffsetMinutes(value) {
      const n = Number(String(value || "").trim());
      if (!Number.isFinite(n)) return null;
      const rounded = Math.round(n);
      if (rounded < 1 || rounded > 1440) return null;
      return rounded;
    }

    function computeTimeFromOffset(offsetMinutes) {
      const targetInstant = new Date(Date.now() + offsetMinutes * 60_000);
      const dt = toOffsetDate(targetInstant);
      const hour = dt.getUTCHours();
      const minute = dt.getUTCMinutes();
      const time = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
      const dayLabel = isSameOffsetDay(targetInstant, new Date()) ? "Today" : "Tomorrow";
      const human = formatOffsetDate(targetInstant, {
        hour: "numeric",
        minute: "2-digit",
        hour12: use12Hour,
      });
      return { hour, minute, time, dayLabel, human };
    }

    function formatPreviewTime(hour, minute) {
      const shiftedNow = toOffsetDate(new Date());
      shiftedNow.setUTCHours(hour, minute, 0, 0);
      const instant = new Date(shiftedNow.getTime() - heartbeatTimezoneOffsetMinutes * 60_000);
      return formatOffsetDate(instant, {
        hour: "numeric",
        minute: "2-digit",
        hour12: use12Hour,
      });
    }

    function formatOffsetDuration(offsetMinutes) {
      const total = Math.max(0, Math.round(offsetMinutes));
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      if (hours <= 0) return minutes + "m";
      if (minutes === 0) return hours + "h";
      return hours + "h " + minutes + "m";
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
        quickJobPreview.textContent = "Runs in " + formatOffsetDuration(offset) + " (" + target.dayLabel + " " + human + ")";
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
      const current = normalizeOffsetMinutes(quickJobOffset.value) || 10;
      const next = Math.min(1440, current + Math.round(delta));
      quickJobOffset.value = String(next);
      updateQuickJobUi();
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest("[data-toggle-job]");
      if (!row || !(row instanceof HTMLElement)) return;
      const name = row.getAttribute("data-toggle-job") || "";
      if (!name) return;
      toggleJobDetails(name);
    });

    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest("[data-delete-job]");
      if (!button || !(button instanceof HTMLButtonElement)) return;
      const name = button.getAttribute("data-delete-job") || "";
      if (!name) return;
      button.disabled = true;
      if (quickJobsStatus) quickJobsStatus.textContent = "Deleting job...";
      try {
        const res = await fetch("/api/jobs/" + encodeURIComponent(name), { method: "DELETE" });
        const out = await res.json();
        if (!out.ok) throw new Error(out.error || "delete failed");
        if (quickJobsStatus) quickJobsStatus.textContent = "Deleted " + name;
        await refreshState();
      } catch (err) {
        if (quickJobsStatus) quickJobsStatus.textContent = "Failed: " + String(err instanceof Error ? err.message : err);
      } finally {
        button.disabled = false;
      }
    });

    if (quickOpenCreate) {
      quickOpenCreate.addEventListener("click", () => setQuickView("create", { scroll: true, user: true }));
    }

    if (quickBackJobs) {
      quickBackJobs.addEventListener("click", () => setQuickView("jobs", { scroll: true, user: true }));
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
            body: JSON.stringify({
              time: target.time,
              prompt,
              recurring: quickJobRecurring ? quickJobRecurring.checked : true,
            }),
          });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "failed");
          quickJobStatus.textContent = "Added to jobs list.";
          if (quickJobsStatus) quickJobsStatus.textContent = "Added " + out.name;
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

    function escAttr(s) {
      return esc(String(s)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    renderClock();
    setInterval(renderClock, 1000);
    startTypewriter();
    updateQuickJobUi();
    setQuickView(quickView);

    loadSettings();
    refreshState();
    setInterval(refreshState, 1000);`;
