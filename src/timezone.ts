const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

export function clampTimezoneOffsetMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, Math.round(value)));
}

export function parseUtcOffsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  if (normalized === "UTC" || normalized === "GMT") return 0;
  const match = normalized.match(/^(UTC|GMT)([+-])(\d{1,2})(?::?([0-5]\d))?$/);
  if (!match) return null;
  const sign = match[2] === "-" ? -1 : 1;
  const hours = Number(match[3]);
  const minutes = Number(match[4] ?? "0");
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 14) return null;
  const total = sign * (hours * 60 + minutes);
  return total < MIN_OFFSET_MINUTES || total > MAX_OFFSET_MINUTES ? null : total;
}

export function normalizeTimezoneName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  const parsedOffset = parseUtcOffsetMinutes(trimmed);
  if (parsedOffset != null) return trimmed.toUpperCase().replace(/\s+/g, "");

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return "";
  }
}

export function resolveTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (Number.isFinite(n)) return clampTimezoneOffsetMinutes(n);
  const parsedFallback = parseUtcOffsetMinutes(timezoneFallback);
  if (parsedFallback != null) return parsedFallback;
  const ianaFallback = getCurrentOffsetMinutesForIanaTimezone(timezoneFallback);
  return ianaFallback == null ? 0 : ianaFallback;
}

export function shiftDateToOffset(date: Date, timezoneOffsetMinutes: number): Date {
  return new Date(date.getTime() + clampTimezoneOffsetMinutes(timezoneOffsetMinutes) * 60_000);
}

export function getDayAndMinuteAtOffset(date: Date, timezoneOffsetMinutes: number): { day: number; minute: number } {
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  return {
    day: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function getCurrentOffsetMinutesForIanaTimezone(timezone: unknown): number | null {
  if (typeof timezone !== "string" || !timezone.trim()) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    }).formatToParts(new Date());
    const token = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const match = token.match(/^GMT([+-])(\d{1,2})(?::?([0-5]\d))?$/i);
    if (!match) return null;
    const sign = match[1] === "-" ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? "0");
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return clampTimezoneOffsetMinutes(sign * (hours * 60 + minutes));
  } catch {
    return null;
  }
}
