// Recurrence engine: a practical subset of RFC 5545 RRULE plus "after completion" mode.
//
// A recurring task is ONE open instance at a time. Completing (or skipping) it
// creates the next instance. The rule moves one "anchor" date (the deadline if
// the task has one, otherwise the planned date); the other date keeps its
// distance to the anchor. Thus "planned 2 days before a Friday deadline,
// every week" stays "planned Wednesday, due Friday" in every instance.

import {
  addDays, addMonths, daysInMonth, dayNum, diffDays, fromDayNum, parseISO, toISO, weekday,
  WEEKDAY_NAMES, type ISODate,
} from "./dates";
import { WEEKDAYS, type Recurrence, type Task, type Weekday } from "./types";

const MAX_ITER = 20_000;

const wdIndex = (w: Weekday) => WEEKDAYS.indexOf(w); // 0 = Sunday

function monthDayDates(y: number, m: number, days: number[]): number[] {
  const dim = daysInMonth(y, m);
  const out: number[] = [];
  for (const d of days) {
    const v = d > 0 ? Math.min(d, dim) : dim + d + 1;
    if (v >= 1 && v <= dim) out.push(v);
  }
  return out;
}

function nthDayDates(y: number, m: number, specs: { day: Weekday; n: number }[]): number[] {
  const dim = daysInMonth(y, m);
  const firstWd = weekday(toISO(y, m, 1));
  const out: number[] = [];
  for (const { day, n } of specs) {
    const wd = wdIndex(day);
    const first = 1 + ((wd - firstWd + 7) % 7);
    if (n > 0) {
      const d = first + 7 * (n - 1);
      if (d <= dim) out.push(d);
    } else {
      let last = first;
      while (last + 7 <= dim) last += 7;
      const d = last + 7 * (n + 1);
      if (d >= 1) out.push(d);
    }
  }
  return out;
}

/** Dates in one month that match the monthly/yearly day selectors. */
function daysInPeriodMonth(rule: Recurrence, y: number, m: number, startDay: number): number[] {
  let days: number[] = [];
  if (rule.byMonthDay?.length) days = days.concat(monthDayDates(y, m, rule.byMonthDay));
  if (rule.byNthDay?.length) days = days.concat(nthDayDates(y, m, rule.byNthDay));
  if (!rule.byMonthDay?.length && !rule.byNthDay?.length) days = monthDayDates(y, m, [startDay]);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** All series dates >= max(rule.start, from), in order. Unbounded unless until/count stop it. */
export function* occurrences(rule: Recurrence, from?: ISODate): Generator<ISODate> {
  const start = rule.start;
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const lower = from && from > start ? from : start;
  const until = rule.until || null;
  const limitByCount = rule.count != null && rule.count > 0;
  // With a count we must enumerate from the start to count correctly.
  const scanFrom = limitByCount ? start : lower;
  let emitted = 0;
  const emit = function* (d: ISODate): Generator<ISODate, boolean> {
    if (d < start) return true;
    if (until && d > until) return false;
    if (limitByCount && emitted >= (rule.count as number)) return false;
    emitted++;
    if (d >= lower) yield d;
    return true;
  };

  const s = parseISO(start);
  let iter = 0;

  if (rule.freq === "daily") {
    const filter = rule.byDay?.length ? new Set(rule.byDay.map(wdIndex)) : null;
    let k = Math.max(0, Math.floor(diffDays(scanFrom, start) / interval));
    while (iter++ < MAX_ITER) {
      const d = fromDayNum(dayNum(start) + k * interval);
      if (!filter || filter.has(weekday(d))) {
        if (!(yield* emit(d))) return;
      }
      k++;
    }
    return;
  }

  if (rule.freq === "weekly") {
    const days = (rule.byDay?.length ? rule.byDay.map(wdIndex) : [weekday(start)])
      .map((wd) => (wd + 6) % 7) // Monday-based offset within the week
      .sort((a, b) => a - b);
    const week0 = dayNum(start) - ((weekday(start) + 6) % 7); // Monday of start week
    let k = Math.max(0, Math.floor((dayNum(scanFrom) - week0) / 7 / interval) - 1);
    while (iter++ < MAX_ITER) {
      const monday = week0 + k * interval * 7;
      for (const off of days) {
        if (!(yield* emit(fromDayNum(monday + off)))) return;
      }
      k++;
    }
    return;
  }

  if (rule.freq === "monthly") {
    const base = s.y * 12 + (s.m - 1);
    const f = parseISO(scanFrom);
    let k = Math.max(0, Math.floor((f.y * 12 + (f.m - 1) - base) / interval) - 1);
    while (iter++ < MAX_ITER) {
      const idx = base + k * interval;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      for (const d of daysInPeriodMonth(rule, y, m, s.d)) {
        if (!(yield* emit(toISO(y, m, d)))) return;
      }
      k++;
    }
    return;
  }

  // yearly
  const months = (rule.byMonth?.length ? rule.byMonth : [s.m]).slice().sort((a, b) => a - b);
  let k = Math.max(0, Math.floor((parseISO(scanFrom).y - s.y) / interval) - 1);
  while (iter++ < MAX_ITER) {
    const y = s.y + k * interval;
    for (const m of months) {
      for (const d of daysInPeriodMonth(rule, y, m, s.d)) {
        if (!(yield* emit(toISO(y, m, d)))) return;
      }
    }
    k++;
  }
}

export function firstOnOrAfter(rule: Recurrence, date: ISODate): ISODate | null {
  for (const d of occurrences(rule, date)) return d;
  return null;
}

export function nextOccurrence(rule: Recurrence, after: ISODate): ISODate | null {
  return firstOnOrAfter(rule, addDays(after, 1));
}

/** Expand dates in [from, to] (inclusive). Used for calendar feeds. */
export function between(rule: Recurrence, from: ISODate, to: ISODate, max = 500): ISODate[] {
  const out: ISODate[] = [];
  for (const d of occurrences(rule, from)) {
    if (d > to || out.length >= max) break;
    out.push(d);
  }
  return out;
}

/** Move the rule start onto the first date that matches the pattern (e.g. "every Mon/Wed" made on a Tuesday). */
export function normalizeRule(rule: Recurrence): Recurrence {
  if (rule.mode === "completion") return rule;
  // search with interval 1 so "every other Tue" made on a Wednesday starts NEXT Tuesday
  // (the phase of the series then begins at that date)
  const first = firstOnOrAfter({ ...rule, interval: 1, count: null, until: null }, rule.start);
  return first && first !== rule.start ? { ...rule, start: first } : rule;
}

/** Which date of a task the rule moves. */
export function anchorOf(t: Pick<Task, "due" | "planned">): "due" | "planned" | null {
  return t.due ? "due" : t.planned ? "planned" : null;
}

/**
 * Dates of the instance that follows `task`, or null when the series has ended.
 * `doneOn` is the local date the current instance was completed or skipped.
 * Missed dates are skipped: finishing a daily task 3 days late does not create 3 overdue copies.
 */
export function nextInstanceDates(
  task: Pick<Task, "due" | "planned" | "recurrence" | "occurrence">,
  doneOn: ISODate,
  today: ISODate,
): { due: ISODate | null; planned: ISODate | null } | null {
  const rule = task.recurrence;
  if (!rule) return null;
  const anchor = anchorOf(task);
  const A = (anchor === "due" ? task.due : anchor === "planned" ? task.planned : null) ?? doneOn;
  const offset = task.due && task.planned ? diffDays(task.planned, task.due) : null;

  let next: ISODate | null;
  if (rule.mode === "completion") {
    const n = Math.max(1, rule.interval || 1);
    next =
      rule.freq === "daily" ? addDays(doneOn, n)
      : rule.freq === "weekly" ? addDays(doneOn, 7 * n)
      : rule.freq === "monthly" ? addMonths(doneOn, n)
      : addMonths(doneOn, 12 * n);
    if (rule.until && next > rule.until) return null;
    if (rule.count && (task.occurrence || 1) + 1 > rule.count) return null;
  } else {
    // count is enforced through occurrence index, not by re-enumeration
    if (rule.count && (task.occurrence || 1) + 1 > rule.count) return null;
    const open = { ...rule, count: null };
    next = nextOccurrence(open, A);
    let guard = 0;
    while (next && next < today && guard++ < 5000) next = nextOccurrence(open, next);
  }
  if (!next) return null;

  if (anchor === "due") return { due: next, planned: offset !== null ? addDays(next, offset) : null };
  return { due: null, planned: next };
}

// ---------- description ----------

const ORD = (n: number) => {
  if (n === -1) return "last";
  if (n === -2) return "second-to-last";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const WD_LONG: Record<Weekday, string> = {
  MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun",
};
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

export function describeRule(rule: Recurrence): string {
  const n = rule.interval || 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
  let s: string;
  const days = rule.byDay?.slice().sort((a, b) => ((wdIndex(a) + 6) % 7) - ((wdIndex(b) + 6) % 7));
  const isWeekdays = days?.length === 5 && ["MO", "TU", "WE", "TH", "FR"].every((d) => days.includes(d as Weekday));

  if (rule.freq === "weekly" && n === 1 && isWeekdays) s = "Every weekday";
  else if (rule.freq === "daily" && isWeekdays) s = n === 1 ? "Every weekday" : `Every ${n} days on weekdays`;
  else s = n === 1 ? `Every ${unit}` : n === 2 ? `Every other ${unit}` : `Every ${n} ${unit}s`;

  if (rule.mode === "completion") return `${s} after completion`;

  if (rule.freq === "weekly" && !isWeekdays) {
    const ds = days?.length ? days : [WEEKDAYS[weekday(rule.start)]];
    s += ` on ${ds.map((d) => WD_LONG[d]).join(", ")}`;
  }
  if (rule.freq === "monthly" || rule.freq === "yearly") {
    const parts: string[] = [];
    rule.byMonthDay?.forEach((d) => parts.push(d === -1 ? "the last day" : `the ${ORD(d)}`));
    rule.byNthDay?.forEach(({ day, n: k }) => parts.push(`the ${ORD(k)} ${WD_LONG[day]}`));
    if (rule.freq === "yearly") {
      const ms = rule.byMonth?.length ? rule.byMonth : [parseISO(rule.start).m];
      const md = parts.length ? parts.join(", ") + " of" : String(parseISO(rule.start).d);
      s += parts.length
        ? ` on ${md} ${ms.map((m) => MONTHS_LONG[m - 1]).join(", ")}`
        : ` on ${ms.map((m) => MONTHS_LONG[m - 1].slice(0, 3)).join(", ")} ${md}`;
    } else {
      s += ` on ${parts.length ? parts.join(", ") : `the ${ORD(parseISO(rule.start).d)}`}`;
    }
  }
  if (rule.until) s += `, until ${rule.until}`;
  if (rule.count) s += `, ${rule.count} times`;
  return s;
}

export const weekdayName = (w: Weekday) => WEEKDAY_NAMES[wdIndex(w)];
