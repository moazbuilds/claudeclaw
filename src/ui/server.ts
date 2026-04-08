import { timingSafeEqual, randomUUID } from "crypto";
import { htmlPage } from "./page/html";
import { clampInt, json } from "./http";
import type { StartWebUiOptions, WebServerHandle } from "./types";
import { buildState, buildTechnicalInfo, sanitizeSettings } from "./services/state";
import { readHeartbeatSettings, updateHeartbeatSettings } from "./services/settings";
import { createQuickJob, deleteJob } from "./services/jobs";
import { fireJob } from "../commands/fire";
import { readLogs } from "./services/logs";

// --- Security: CSRF Protection ---
// NOTE: The Web UI has no built-in authentication. CSRF protection prevents
// cross-origin browser attacks but does not prevent direct API access.
// For production use, deploy behind a reverse proxy with authentication
// (e.g. Cloudflare Access, nginx basic auth, or OAuth2 proxy).
const CSRF_HEADER_NAME = "X-CSRF-Token";
const MAX_CSRF_TOKENS = 10000;

interface CsrfEntry {
  tokens: Array<{ token: string; expiresAt: number }>;
}

const csrfTokens = new Map<string, CsrfEntry>();

function generateCsrfToken(sessionId: string): string {
  // Evict expired tokens and enforce max size
  if (csrfTokens.size > MAX_CSRF_TOKENS) {
    const now = Date.now();
    for (const [key, entry] of csrfTokens) {
      const valid = entry.tokens.filter((t) => now <= t.expiresAt);
      if (valid.length === 0) {
        csrfTokens.delete(key);
      } else {
        csrfTokens.set(key, { tokens: valid });
      }
    }
    // If still over limit after cleanup, remove oldest entry
    if (csrfTokens.size > MAX_CSRF_TOKENS) {
      const firstKey = csrfTokens.keys().next().value;
      if (firstKey) csrfTokens.delete(firstKey);
    }
  }

  const token = randomUUID();
  const newToken = { token, expiresAt: Date.now() + 3600000 }; // 1 hour
  const existing = csrfTokens.get(sessionId);
  const tokens = existing ? [...existing.tokens.slice(-4), newToken] : [newToken];
  csrfTokens.set(sessionId, { tokens });
  return token;
}

function validateCsrfToken(sessionId: string, token: string): boolean {
  const entry = csrfTokens.get(sessionId);
  if (!entry) return false;
  const now = Date.now();
  const validTokens = entry.tokens.filter((t) => now <= t.expiresAt);
  if (validTokens.length === 0) {
    csrfTokens.delete(sessionId);
    return false;
  }
  const matchIndex = validTokens.findIndex((t) => {
    const a = Buffer.from(t.token);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  });
  if (matchIndex === -1) {
    // Update entry to only keep valid (non-expired) tokens
    csrfTokens.set(sessionId, { tokens: validTokens });
    return false;
  }
  // Consume the token to prevent replay attacks
  validTokens.splice(matchIndex, 1);
  if (validTokens.length === 0) {
    csrfTokens.delete(sessionId);
  } else {
    csrfTokens.set(sessionId, { tokens: validTokens });
  }
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getOrCreateSessionId(req: Request): { sessionId: string; setCookie?: string } {
  const existing = req.headers.get("Cookie")?.match(/session_id=([^;]+)/)?.[1];
  if (existing && UUID_RE.test(existing)) return { sessionId: existing };
  // Invalid format or missing — issue a new session
  const isSecure = req.headers.get("x-forwarded-proto") === "https" || req.url.startsWith("https");
  const securePart = isSecure ? "; Secure" : "";
  const newId = randomUUID();
  return {
    sessionId: newId,
    setCookie: `session_id=${newId}; Path=/; HttpOnly; SameSite=Strict${securePart}`,
  };
}

/** Returns a 403 Response if the CSRF token is missing or invalid, otherwise null. */
function requireCsrf(req: Request): Response | null {
  const csrfToken = req.headers.get(CSRF_HEADER_NAME);
  const { sessionId } = getOrCreateSessionId(req);
  if (!csrfToken || !validateCsrfToken(sessionId, csrfToken)) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid CSRF token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export function startWebUi(opts: StartWebUiOptions): WebServerHandle {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
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

      if (url.pathname === "/api/csrf-token") {
        const { sessionId, setCookie } = getOrCreateSessionId(req);
        const token = generateCsrfToken(sessionId);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        };
        if (setCookie) headers["Set-Cookie"] = setCookie;
        return new Response(JSON.stringify({ token }), { headers });
      }

      if (url.pathname === "/api/state") {
        return json(await buildState(opts.getSnapshot()));
      }

      if (url.pathname === "/api/settings") {
        return json(sanitizeSettings(opts.getSnapshot().settings));
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
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
          console.error("Heartbeat settings update failed:", err);
          return json({ ok: false, error: "Failed to update heartbeat settings" });
        }
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "GET") {
        try {
          return json({ ok: true, heartbeat: await readHeartbeatSettings() });
        } catch (err) {
          console.error("Heartbeat settings read failed:", err);
          return json({ ok: false, error: "Failed to read heartbeat settings" });
        }
      }

      if (url.pathname === "/api/technical-info") {
        return json(await buildTechnicalInfo(opts.getSnapshot()));
      }

      if (url.pathname === "/api/jobs/quick" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = await req.json();
          const result = await createQuickJob(body as { time?: unknown; prompt?: unknown });
          if (opts.onJobsChanged) await opts.onJobsChanged();
          return json({ ok: true, ...result });
        } catch (err) {
          console.error("Quick job creation failed:", err);
          return json({ ok: false, error: "Failed to create job" });
        }
      }

      if (url.pathname.startsWith("/api/jobs/") && req.method === "DELETE") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const encodedName = url.pathname.slice("/api/jobs/".length);
          const name = decodeURIComponent(encodedName);
          await deleteJob(name);
          if (opts.onJobsChanged) await opts.onJobsChanged();
          return json({ ok: true });
        } catch (err) {
          console.error("Job deletion failed:", err);
          return json({ ok: false, error: "Failed to delete job" });
        }
      }

      if (url.pathname === "/api/jobs") {
        const jobs = opts.getSnapshot().jobs.map((j) => ({
          name: j.name,
          schedule: j.schedule,
          promptPreview: j.prompt.slice(0, 160),
          agent: j.agent,
          label: j.label,
          fireable: Boolean(j.agent && j.label),
        }));
        return json({ jobs });
      }

      if (url.pathname === "/api/jobs/fire" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = (await req.json()) as { agent?: unknown; label?: unknown };
          const agent = typeof body.agent === "string" ? body.agent.trim() : "";
          const label = typeof body.label === "string" ? body.label.trim() : "";
          if (!agent || !label) {
            return json({ ok: false, error: "agent and label are required" });
          }
          const result = await fireJob(agent, label);
          return json({
            ok: result.success,
            success: result.success,
            exitCode: result.exitCode,
            output: result.output,
            error: result.error,
            agent,
            label,
          });
        } catch (err) {
          console.error("Fire job failed:", err);
          return json({ ok: false, error: "Failed to fire job" });
        }
      }

      if (url.pathname === "/api/logs") {
        const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
        return json(await readLogs(tail));
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        if (!opts.onChat) return json({ ok: false, error: "chat not configured" });
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
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
                  () => send({ type: "unblock" })
                );
                send({ type: "done" });
              } catch (err) {
                console.error("Chat stream error:", err);
                send({ type: "error", message: "An internal error occurred" });
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
          console.error("Chat request failed:", err);
          return json({ ok: false, error: "Chat request failed" });
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
