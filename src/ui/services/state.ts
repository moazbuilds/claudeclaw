import { readFile } from "fs/promises";
import { peekSession } from "../../sessions";
import { SESSION_FILE, SETTINGS_FILE, STATE_FILE } from "../constants";
import type { WebSnapshot } from "../types";

export function sanitizeSettings(snapshot: WebSnapshot["settings"]) {
  return {
    timezone: snapshot.timezone,
    timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
    heartbeat: snapshot.heartbeat,
    security: snapshot.security,
    telegram: {
      configured: Boolean(snapshot.telegram.token),
      allowedUserCount: snapshot.telegram.allowedUserIds.length,
    },
    discord: {
      configured: Boolean(snapshot.discord.token),
      allowedUserCount: snapshot.discord.allowedUserIds.length,
    },
    web: snapshot.web,
  };
}

export async function buildState(snapshot: WebSnapshot) {
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
    jobs: snapshot.jobs.map((j) => ({
      name: j.name,
      schedule: j.schedule,
      prompt: j.prompt,
    })),
    security: snapshot.settings.security,
    telegram: {
      configured: Boolean(snapshot.settings.telegram.token),
      allowedUserCount: snapshot.settings.telegram.allowedUserIds.length,
    },
    discord: {
      configured: Boolean(snapshot.settings.discord.token),
      allowedUserCount: snapshot.settings.discord.allowedUserIds.length,
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

function redactSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };
  if ("apiToken" in out) out.apiToken = out.apiToken ? "[redacted]" : undefined;
  if (out.telegram && typeof out.telegram === "object") {
    const t = out.telegram as Record<string, unknown>;
    out.telegram = { ...t, token: t.token ? "[redacted]" : "" };
  }
  if (out.discord && typeof out.discord === "object") {
    const d = out.discord as Record<string, unknown>;
    out.discord = { ...d, token: d.token ? "[redacted]" : "" };
  }
  if (out.slack && typeof out.slack === "object") {
    const sl = out.slack as Record<string, unknown>;
    out.slack = { ...sl, botToken: sl.botToken ? "[redacted]" : "", appToken: sl.appToken ? "[redacted]" : "" };
  }
  return out;
}

export async function buildTechnicalInfo(snapshot: WebSnapshot) {
  const rawSettings = await readJsonFile(SETTINGS_FILE);
  return {
    daemon: {
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: Math.max(0, Date.now() - snapshot.startedAt),
    },
    files: {
      settingsJson: redactSettings(rawSettings),
      sessionJson: await readJsonFile(SESSION_FILE),
      stateJson: await readJsonFile(STATE_FILE),
    },
    snapshot: {
      ...snapshot,
      settings: redactSettings(snapshot.settings) as WebSnapshot["settings"],
    },
  };
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
