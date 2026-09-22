export type DurationMs = number;

export const DURATION = Object.freeze({
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  ambientDelayMin: 15_000,
  ambientDelayMax: 30_000,
  cooldownMin: 180_000,
  cooldownMax: 300_000,
  replyTokenSafetyMargin: 45_000,
  contextWindow: 10 * 60_000
} as const);

export const DURATIONS = DURATION;

const durationUnits: Record<string, number> = {
  ms: DURATION.millisecond,
  s: DURATION.second,
  sec: DURATION.second,
  m: DURATION.minute,
  min: DURATION.minute,
  h: DURATION.hour,
  hr: DURATION.hour,
  d: DURATION.day,
  day: DURATION.day
};

export function parseDuration(value: string | number): DurationMs {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Duration must be positive and finite");
    return value;
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d|day)\s*$/i.exec(value);
  if (!match) throw new RangeError(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = durationUnits[match[2].toLowerCase()];
  const milliseconds = amount * unit;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new RangeError(`Invalid duration: ${value}`);
  return milliseconds;
}

export function utcDate(value: Date | string | number): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  return new Date(date.getTime());
}

export const toUtcIso = (value: Date | string | number): string => utcDate(value).toISOString();

const bangkokFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export function bangkokBudgetDay(value: Date | string | number): string {
  return bangkokFormatter.format(utcDate(value));
}

export const budgetDay = bangkokBudgetDay;

export function startOfBangkokBudgetDay(value: Date | string | number): Date {
  const day = bangkokBudgetDay(value);
  const [year, month, date] = day.split("-").map(Number);
  // Bangkok is UTC+07:00 and has no DST. Keeping this conversion explicit
  // makes the daily budget boundary independent of the host time zone.
  return new Date(Date.UTC(year, month - 1, date) - 7 * DURATION.hour);
}

export function isSameBangkokDay(left: Date | string | number, right: Date | string | number): boolean {
  return bangkokBudgetDay(left) === bangkokBudgetDay(right);
}

export function addDuration(value: Date | string | number, duration: DurationMs): Date {
  if (!Number.isFinite(duration)) throw new RangeError("Duration must be finite");
  return new Date(utcDate(value).getTime() + duration);
}

export function age(value: Date | string | number, now: Date | string | number): DurationMs {
  return utcDate(now).getTime() - utcDate(value).getTime();
}
