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

export async function buildTechnicalInfo(snapshot: WebSnapshot) {
  return {
    daemon: {
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: Math.max(0, Date.now() - snapshot.startedAt),
    },
    files: {
      settingsJson: await readJsonFile(SETTINGS_FILE),
      sessionJson: await readJsonFile(SESSION_FILE),
      stateJson: await readJsonFile(STATE_FILE),
    },
    snapshot,
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
