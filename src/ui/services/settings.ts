import { readFile, writeFile } from "fs/promises";
import { SETTINGS_FILE } from "../constants";

export async function setHeartbeatEnabled(enabled: boolean): Promise<void> {
  await updateHeartbeatSettings({ enabled });
}

export interface HeartbeatSettingsPatch {
  enabled?: boolean;
  interval?: number;
  prompt?: string;
  timezone?: string;
  excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
}

export interface HeartbeatSettingsData {
  enabled: boolean;
  interval: number;
  prompt: string;
  timezone: string;
  excludeWindows: Array<{ days?: number[]; start: string; end: string }>;
}

export async function readHeartbeatSettings(): Promise<HeartbeatSettingsData> {
  const raw = await readFile(SETTINGS_FILE, "utf-8");
  const data = JSON.parse(raw) as Record<string, any>;
  if (!data.heartbeat || typeof data.heartbeat !== "object") data.heartbeat = {};
  return {
    enabled: Boolean(data.heartbeat.enabled),
    interval: Number(data.heartbeat.interval) || 15,
    prompt: typeof data.heartbeat.prompt === "string" ? data.heartbeat.prompt : "",
    timezone: typeof data.heartbeat.timezone === "string" ? data.heartbeat.timezone : "",
    excludeWindows: Array.isArray(data.heartbeat.excludeWindows) ? data.heartbeat.excludeWindows : [],
  };
}

export async function updateHeartbeatSettings(patch: HeartbeatSettingsPatch): Promise<HeartbeatSettingsData> {
  const raw = await readFile(SETTINGS_FILE, "utf-8");
  const data = JSON.parse(raw) as Record<string, any>;
  if (!data.heartbeat || typeof data.heartbeat !== "object") data.heartbeat = {};

  if (typeof patch.enabled === "boolean") {
    data.heartbeat.enabled = patch.enabled;
  }
  if (typeof patch.interval === "number" && Number.isFinite(patch.interval)) {
    const clamped = Math.max(1, Math.min(1440, Math.round(patch.interval)));
    data.heartbeat.interval = clamped;
  }
  if (typeof patch.prompt === "string") {
    data.heartbeat.prompt = patch.prompt;
  }
  if (typeof patch.timezone === "string") {
    data.heartbeat.timezone = patch.timezone;
  }
  if (Array.isArray(patch.excludeWindows)) {
    data.heartbeat.excludeWindows = patch.excludeWindows;
  }

  await writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
  return {
    enabled: Boolean(data.heartbeat.enabled),
    interval: Number(data.heartbeat.interval) || 15,
    prompt: typeof data.heartbeat.prompt === "string" ? data.heartbeat.prompt : "",
    timezone: typeof data.heartbeat.timezone === "string" ? data.heartbeat.timezone : "",
    excludeWindows: Array.isArray(data.heartbeat.excludeWindows) ? data.heartbeat.excludeWindows : [],
  };
}
