import { shiftDateToOffset } from "./timezone";

function matchCronField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date, timezoneOffsetMinutes = 0): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  const d = {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    dayOfWeek: shifted.getUTCDay(),
  };

  return (
    matchCronField(minute, d.minute) &&
    matchCronField(hour, d.hour) &&
    matchCronField(dayOfMonth, d.dayOfMonth) &&
    matchCronField(month, d.month) &&
    matchCronField(dayOfWeek, d.dayOfWeek)
  );
}

export function nextCronMatch(expr: string, after: Date, timezoneOffsetMinutes = 0): Date {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 2880; i++) {
    if (cronMatches(expr, d, timezoneOffsetMinutes)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return d;
}
