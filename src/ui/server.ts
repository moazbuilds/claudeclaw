import { htmlPage } from "./page/html";
import { clampInt, json } from "./http";
import { checkToken } from "./auth";
import type { StartWebUiOptions, WebServerHandle } from "./types";
import { buildState, buildTechnicalInfo, sanitizeSettings } from "./services/state";
import { readHeartbeatSettings, updateHeartbeatSettings } from "./services/settings";
import { createQuickJob, deleteJob } from "./services/jobs";
import { readLogs } from "./services/logs";
import { listSessions, readSessionMessages, listAgents } from "./services/sessions";
import { runUserMessage } from "../runner";

export function startWebUi(opts: StartWebUiOptions): WebServerHandle {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Task 1.2: Reject DNS rebinding attacks via Host header validation.
      // Wildcard bind addresses (0.0.0.0, ::) mean the user opted into remote access —
      // the browser Host header won't match the bind address, so we skip the check.
      // For specific bind addresses (loopback or LAN IP) we enforce the allowlist.
      const host = req.headers.get("host") ?? "";
      const isWildcardBind = opts.host === "0.0.0.0" || opts.host === "::";
      if (!isWildcardBind) {
        const expectedHosts = new Set([
          `127.0.0.1:${opts.port}`,
          `localhost:${opts.port}`,
          `[::1]:${opts.port}`,
          `${opts.host}:${opts.port}`,
        ]);
        if (!expectedHosts.has(host)) {
          return new Response("Bad Host", { status: 421 });
        }
      }

      // Task 1.3: CSRF defense — reject cross-origin requests for state-changing methods
      if (req.method === "POST" || req.method === "DELETE") {
        const origin = req.headers.get("origin");
        if (origin) {
          const expectedOrigin = `http://${host}`;
          if (origin !== expectedOrigin) {
            return new Response("Bad Origin", { status: 403 });
          }
        }
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Task 1.1: Require bearer token for all /api/* routes.
      // /api/inject also accepts the legacy settings.apiToken so existing automation isn't broken.
      if (url.pathname.startsWith("/api/")) {
        const apiToken = opts.getSnapshot().settings.apiToken;
        const validWebToken = checkToken(req, opts.token);
        const validApiToken =
          url.pathname === "/api/inject" && !!apiToken && checkToken(req, apiToken);
        if (!validWebToken && !validApiToken) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
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
          const payload = body as {
            enabled?: unknown;
            interval?: unknown;
            prompt?: unknown;
            excludeWindows?: unknown;
          };
          const patch: {
            enabled?: boolean;
            interval?: number;
            prompt?: string;
            excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
          } = {};

          if ("enabled" in payload) patch.enabled = Boolean(payload.enabled);
          if ("interval" in payload) {
            const iv = Number(payload.interval);
            if (!Number.isFinite(iv)) throw new Error("interval must be numeric");
            patch.interval = iv;
          }
          if ("prompt" in payload) patch.prompt = String(payload.prompt ?? "");
          if ("excludeWindows" in payload) {
            if (!Array.isArray(payload.excludeWindows)) {
              throw new Error("excludeWindows must be an array");
            }
            patch.excludeWindows = payload.excludeWindows
              .filter((entry) => entry && typeof entry === "object")
              .map((entry) => {
                const row = entry as Record<string, unknown>;
                const start = String(row.start ?? "").trim();
                const end = String(row.end ?? "").trim();
                const days = Array.isArray(row.days)
                  ? row.days
                      .map((d) => Number(d))
                      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
                  : undefined;
                return {
                  start,
                  end,
                  ...(days && days.length > 0 ? { days } : {}),
                };
              });
          }

          if (
            !("enabled" in patch) &&
            !("interval" in patch) &&
            !("prompt" in patch) &&
            !("excludeWindows" in patch)
          ) {
            throw new Error("no heartbeat fields provided");
          }

          const next = await updateHeartbeatSettings(patch);
          if (opts.onHeartbeatEnabledChanged && "enabled" in patch) {
            await opts.onHeartbeatEnabledChanged(Boolean(patch.enabled));
          }
          if (opts.onHeartbeatSettingsChanged) {
            await opts.onHeartbeatSettingsChanged(patch);
          }
          return json({ ok: true, heartbeat: next });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "GET") {
        try {
          return json({ ok: true, heartbeat: await readHeartbeatSettings() });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/technical-info") {
        return json(await buildTechnicalInfo(opts.getSnapshot()));
      }

      if (url.pathname === "/api/jobs/quick" && req.method === "POST") {
        try {
          const body = await req.json();
          const result = await createQuickJob(body as { time?: unknown; prompt?: unknown });
          if (opts.onJobsChanged) await opts.onJobsChanged();
          return json({ ok: true, ...result });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname.startsWith("/api/jobs/") && req.method === "DELETE") {
        try {
          const encodedName = url.pathname.slice("/api/jobs/".length);
          const name = decodeURIComponent(encodedName);
          await deleteJob(name);
          if (opts.onJobsChanged) await opts.onJobsChanged();
          return json({ ok: true });
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

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        try {
          return json(await listSessions());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        try {
          return json(await listAgents());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages") && req.method === "GET") {
        const sessionId = url.pathname.slice("/api/sessions/".length, -"/messages".length);
        const limit = clampInt(url.searchParams.get("limit"), 10, 1, 2000);
        const rawOffset = url.searchParams.get("offset");
        const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 100_000);
        try {
          return json(await readSessionMessages(sessionId, limit, offset));
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/inject" && req.method === "POST") {
        try {
          const body = await req.json();
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) return json({ ok: false, error: "message is required" }, 400);
          const result = await runUserMessage("inject", message);
          const text = result.stdout.trim();
          const { telegram } = opts.getSnapshot().settings;
          if (text && telegram.token && telegram.allowedUserIds.length > 0) {
            const chatId = telegram.allowedUserIds[0];
            fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text }),
            }).catch(() => {});
          }
          return json({ ok: true, result: result.stdout, exitCode: result.exitCode });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        if (!opts.onChat) return json({ ok: false, error: "chat not configured" });
        try {
          const body = await req.json();
          const message = String(body?.message ?? "").trim();
          if (!message) return json({ ok: false, error: "message required" });

          const encoder = new TextEncoder();
          const onChat = opts.onChat;
          const stream = new ReadableStream({
            async start(controller) {
              const send = (data: object) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              };
              try {
                await onChat(
                  message,
                  (chunk) => send({ type: "chunk", text: chunk }),
                  () => send({ type: "unblock" }),
                  (ev) => send({ type: ev.type === "spawn" ? "agent_spawn" : "agent_done", id: ev.id, description: ev.description, result: ev.result })
                );
                send({ type: "done" });
              } catch (err) {
                send({ type: "error", message: String(err) });
              } finally {
                controller.close();
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
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
