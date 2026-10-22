// Calendar arithmetic on plain local dates ("YYYY-MM-DD") and wall times ("HH:MM").
// Dates are never stored as instants: a planned date is a day in the user's life,
// not a UTC timestamp. Conversion to an instant happens only for notifications.

export type ISODate = string; // "2026-10-21"
export type HHMM = string; // "14:30"

const DAY_MS = 86_400_000;

export const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function toISO(y: number, m: number, d: number): ISODate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function parseISO(s: ISODate): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseISO(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Days since 1970-01-01. */
export function dayNum(s: ISODate): number {
  const { y, m, d } = parseISO(s);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNum(n: number): ISODate {
  const dt = new Date(n * DAY_MS);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export const addDays = (s: ISODate, n: number) => fromDayNum(dayNum(s) + n);
export const diffDays = (a: ISODate, b: ISODate) => dayNum(a) - dayNum(b);

/** 0 = Sunday ... 6 = Saturday */
export const weekday = (s: ISODate) => new Date(dayNum(s) * DAY_MS).getUTCDay();

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add months, clamping the day to the end of the target month (Jan 31 + 1 month = Feb 28). */
export function addMonths(s: ISODate, n: number): ISODate {
  const { y, m, d } = parseISO(s);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return toISO(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function startOfWeek(s: ISODate, weekStart = 1): ISODate {
  const wd = weekday(s);
  return addDays(s, -((wd - weekStart + 7) % 7));
}

export const minDate = (a?: ISODate | null, b?: ISODate | null) =>
  !a ? b ?? null : !b ? a : a < b ? a : b;

// ---------- times ----------

export function parseHM(t: HHMM): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
export function fmtHM(mins: number): HHMM {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
export function isHHMM(t: unknown): t is HHMM {
  return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

// ---------- time zones ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  if (p.hour === 24) p.hour = 0;
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

export function epochToZoned(ms: number, tz: string): { date: ISODate; time: HHMM } {
  const p = zonedParts(ms, tz);
  return { date: toISO(p.y, p.m, p.d), time: `${pad(p.h)}:${pad(p.mi)}` };
}

function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant of a local wall time in a zone. For a time that does not exist
 * (spring-forward gap) the result moves forward; for an ambiguous time
 * (fall-back) the first occurrence is used.
 */
export function zonedToEpoch(date: ISODate, time: HHMM, tz: string): number {
  const { y, m, d } = parseISO(date);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetMs(guess, tz);
  let t = guess - o1;
  const o2 = offsetMs(t, tz);
  if (o2 !== o1) {
    const t2 = guess - o2;
    // Prefer the candidate whose wall time matches; otherwise take the later instant (gap).
    t = offsetMs(t2, tz) === o2 ? Math.min(t, t2) : Math.max(t, t2);
  }
  return t;
}

export function todayIn(tz: string, now = Date.now()): ISODate {
  return epochToZoned(now, tz).date;
}

export function localTZ(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ---------- display ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_NAMES = MONTHS;
export const WEEKDAY_NAMES = WDAYS;

/** "Today", "Tomorrow", "Fri", "Oct 30", "Jan 4, 2027" relative to today. */
export function relDate(s: ISODate, today: ISODate): string {
  const n = diffDays(s, today);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  const { y, m, d } = parseISO(s);
  if (n > 1 && n < 7) return WDAYS[weekday(s)];
  const ty = parseISO(today).y;
  return y === ty ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function longDate(s: ISODate): string {
  const { y, m, d } = parseISO(s);
  return `${WDAYS[weekday(s)]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "9:30 AM" style. */
export function fmtTime12(t: HHMM): string {
  const mins = parseHM(t);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${ap}` : `${h12}:${pad(m)} ${ap}`;
}

/** 95 -> "1h 35m" */
export function fmtDuration(mins: number | null | undefined): string {
  if (!mins || mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
