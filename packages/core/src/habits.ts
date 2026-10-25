// Habits: Streaks-style tracking with flexible schedules.
//
// A streak counts consecutive periods in which the habit met its schedule:
//   daily / days   -> days (for "days", unscheduled days are skipped, not misses)
//   week / month   -> weeks / months in which it was done at least n times
//   interval       -> check-ins, each no more than n days after the previous one
// The current period never breaks a streak while it can still be met.

import { addDays, addMonths, dayNum, diffDays, fromDayNum, parseISO, startOfWeek, toISO, weekday, type ISODate } from "./dates";
import { awardRitual, reconcileRitualDay } from "./game";
import type { Store } from "./store";
import { randomId } from "./sync";
import type { Habit, HabitSchedule, Trait } from "./types";

export const dayKey = (d: ISODate) => `d:${d}` as const;
export const perDayOf = (h: Habit) => Math.max(1, Math.floor(h.perDay ?? 1));

/** Every field that holds a count for this day (the legacy whole-day field and one per device). */
function dayFields(h: Habit, d: ISODate): string[] {
  const k = dayKey(d);
  return Object.keys(h).filter((f) => f === k || f.startsWith(k + ":"));
}

/** Check-ins recorded for a day, summed over devices. */
export function countOn(h: Habit, d: ISODate): number {
  let n = 0;
  for (const f of dayFields(h, d)) n += Math.max(0, Number((h as any)[f]) || 0);
  return n;
}

/** The day met the habit's daily target. */
export const isDone = (h: Habit, d: ISODate) => countOn(h, d) >= perDayOf(h);

/** All dates with a met target, ascending. */
export function doneDates(h: Habit): ISODate[] {
  const days = new Set<string>();
  for (const k of Object.keys(h)) if (k.startsWith("d:")) days.add(k.slice(2, 12));
  return [...days].filter((d) => isDone(h, d)).sort();
}

export function createHabit(store: Store, name: string, schedule: HabitSchedule = { type: "daily" }, glyph?: string, perDay = 1, traits: Trait[] = []): Habit {
  const hs = store.habits;
  const order = (hs[hs.length - 1]?.order ?? 0) + 1;
  return store.insert<Habit>({
    id: randomId(),
    kind: "habit",
    _c: {},
    createdAt: new Date().toISOString(),
    name: name.trim() || "Habit",
    glyph: (glyph ?? defaultGlyph(name)).slice(0, 2),
    schedule,
    perDay: Math.max(1, Math.floor(perDay)),
    traits: [...traits],
    order,
    archived: false,
    deleted: false,
  } as Habit);
}

export function defaultGlyph(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w[0]?.[0] ?? "H").toUpperCase();
}

/** Set a day's total count: this device's field gets n, every other field for the day 0. */
export function setCount(store: Store, id: string, d: ISODate, n: number) {
  const h = store.get<Habit>(id);
  if (!h) return;
  const patch: Record<string, number> = {};
  for (const f of dayFields(h, d)) patch[f] = 0;
  patch[`${dayKey(d)}:${store.meta.node}`] = Math.max(0, Math.floor(n));
  store.batch(() => {
    store.update<Habit>(id, patch as Partial<Habit>);
    reconcileRitualDay(store, store.get<Habit>(id)!, d, Math.max(0, Math.floor(n)));
  });
}

/** Add one check-in from this device. Returns the day's new total. */
export function addCheckIn(store: Store, id: string, d: ISODate): number {
  const h = store.get<Habit>(id);
  if (!h) return 0;
  const own = `${dayKey(d)}:${store.meta.node}`;
  const mine = (Number((h as any)[own]) || 0) + 1;
  store.batch(() => {
    store.update<Habit>(id, { [own]: mine } as Partial<Habit>);
    awardRitual(store, store.get<Habit>(id)!, d, mine);
  });
  return countOn(store.get<Habit>(id)!, d);
}

/** Mark a whole day done (its full daily target) or not done. */
export function setDone(store: Store, id: string, d: ISODate, done: boolean) {
  const h = store.get<Habit>(id);
  if (h) setCount(store, id, d, done ? perDayOf(h) : 0);
}

/**
 * The ring's press-and-hold: add one check-in until today's target is met; once met,
 * the next hold resets the day to 0. Returns the previous count (for undo) and the new one.
 */
export function holdCheckIn(store: Store, id: string, d: ISODate): { before: number; after: number } {
  const h = store.get<Habit>(id);
  if (!h) return { before: 0, after: 0 };
  const before = countOn(h, d);
  if (before >= perDayOf(h)) {
    setCount(store, id, d, 0);
    return { before, after: 0 };
  }
  return { before, after: addCheckIn(store, id, d) };
}

export function toggleDone(store: Store, id: string, d: ISODate): boolean {
  const h = store.get<Habit>(id);
  if (!h) return false;
  const next = !isDone(h, d);
  setDone(store, id, d, next);
  return next;
}

// ---------- periods ----------

const periodStart = (s: HabitSchedule, d: ISODate, weekStart: number): ISODate => {
  if (s.type === "week") return startOfWeek(d, weekStart);
  if (s.type === "month") {
    const { y, m } = parseISO(d);
    return toISO(y, m, 1);
  }
  return d;
};
const nextPeriod = (s: HabitSchedule, start: ISODate): ISODate =>
  s.type === "week" ? addDays(start, 7) : s.type === "month" ? addMonths(start, 1) : addDays(start, 1);
const prevPeriod = (s: HabitSchedule, start: ISODate): ISODate =>
  s.type === "week" ? addDays(start, -7) : s.type === "month" ? addMonths(start, -1) : addDays(start, -1);

const target = (s: HabitSchedule) => Math.max(1, Math.floor(s.n ?? 1));
const scheduledDay = (s: HabitSchedule, d: ISODate) =>
  s.type !== "days" || !s.days?.length || s.days.includes(weekday(d));

/** Days with a met target in [from, toExcl). */
function countIn(h: Habit, from: ISODate, toExcl: ISODate): number {
  let n = 0;
  for (let d = from; d < toExcl; d = addDays(d, 1)) if (isDone(h, d)) n++;
  return n;
}

export interface HabitState {
  doneToday: boolean;
  /** check-ins today and the daily target */
  today: { count: number; target: number };
  /** for week/month: done so far and target in the current period */
  progress: { done: number; target: number } | null;
  /** due today (or still needed in this period) */
  due: boolean;
  /** for interval habits not due today: the day it is next due */
  nextDue: ISODate | null;
  /** short line for under the circle */
  label: string;
}

export function habitState(h: Habit, today: ISODate, weekStart = 1): HabitState {
  const s = h.schedule;
  const doneToday = isDone(h, today);
  const k = perDayOf(h);
  const day = { count: countOn(h, today), target: k };
  const st = habitStateBase(h, today, weekStart, doneToday);
  if (k > 1) {
    const c = Math.min(day.count, k);
    if (s.type === "week" || s.type === "month") st.label = `${st.label}, ${c} of ${k} today`;
    else if (!doneToday && (st.due || day.count > 0)) st.label = `${c} of ${k} today`;
  }
  return { ...st, today: day };
}

function habitStateBase(h: Habit, today: ISODate, weekStart: number, doneToday: boolean): Omit<HabitState, "today"> {
  const s = h.schedule;
  if (s.type === "week" || s.type === "month") {
    const start = periodStart(s, today, weekStart);
    const done = countIn(h, start, addDays(today, 1));
    const t = target(s);
    const unit = s.type === "week" ? "this week" : "this month";
    return { doneToday, progress: { done, target: t }, due: done < t, nextDue: null, label: `${Math.min(done, t)} of ${t} ${unit}` };
  }
  if (s.type === "interval") {
    const n = target(s);
    const last = [...doneDates(h)].reverse().find((d) => d <= today) ?? null;
    if (doneToday) return { doneToday, progress: null, due: false, nextDue: addDays(today, n), label: "Done today" };
    if (!last) return { doneToday, progress: null, due: true, nextDue: today, label: "Due today" };
    const next = addDays(last, n);
    if (next <= today) return { doneToday, progress: null, due: true, nextDue: next, label: next < today ? "Overdue" : "Due today" };
    const k = diffDays(next, today);
    return { doneToday, progress: null, due: false, nextDue: next, label: k === 1 ? "Due tomorrow" : `Due in ${k} days` };
  }
  const sched = scheduledDay(s, today);
  return {
    doneToday,
    progress: null,
    due: sched && !doneToday,
    nextDue: null,
    label: doneToday ? "Done today" : sched ? "Due today" : "Rest day",
  };
}

// ---------- streaks ----------

export interface Streak {
  current: number;
  best: number;
  unit: "day" | "week" | "month" | "time";
}

/** Streak counting from the habit's first check-in (or creation) up to today. */
export function streak(h: Habit, today: ISODate, weekStart = 1): Streak {
  const s = h.schedule;
  const dates = doneDates(h).filter((d) => d <= today);
  if (!dates.length) return { current: 0, best: 0, unit: unitOf(s) };

  if (s.type === "interval") {
    const n = target(s);
    let best = 1, run = 1;
    for (let i = 1; i < dates.length; i++) {
      run = diffDays(dates[i], dates[i - 1]) <= n ? run + 1 : 1;
      best = Math.max(best, run);
    }
    const alive = diffDays(today, dates[dates.length - 1]) <= n;
    return { current: alive ? run : 0, best, unit: "time" };
  }

  // walk periods from the first check-in to the current one
  const first = periodStart(s, dates[0], weekStart);
  const cur = periodStart(s, today, weekStart);
  const t = s.type === "week" || s.type === "month" ? target(s) : 1;
  let run = 0, best = 0;
  for (let p = first; p <= cur; p = nextPeriod(s, p)) {
    if ((s.type === "daily" || s.type === "days") && !scheduledDay(s, p)) continue; // rest day: neither counts nor breaks
    const end = nextPeriod(s, p);
    const met = countIn(h, p, end > addDays(today, 1) ? addDays(today, 1) : end) >= t;
    if (met) {
      run++;
      best = Math.max(best, run);
    } else if (p !== cur) {
      run = 0; // a finished period that missed its target breaks the streak
    }
    // the current period, not yet met, leaves the streak as it is
  }
  return { current: run, best: Math.max(best, run), unit: unitOf(s) };
}

const unitOf = (s: HabitSchedule): Streak["unit"] =>
  s.type === "week" ? "week" : s.type === "month" ? "month" : s.type === "interval" ? "time" : "day";

export function streakLabel(st: Streak): string {
  const u = st.unit;
  const n = st.current;
  return `${n} ${u}${n === 1 ? "" : "s"}`;
}

// ---------- statistics ----------

export interface HabitStats {
  total: number;
  /** share of scheduled days (or required check-ins) met in the last 30 days, 0..1 */
  rate30: number;
  since: ISODate;
}

export function habitStats(h: Habit, today: ISODate, weekStart = 1): HabitStats {
  const dates = doneDates(h).filter((d) => d <= today);
  const created = h.createdAt.slice(0, 10) as ISODate;
  const since = dates[0] && dates[0] < created ? dates[0] : created;
  const from = addDays(today, -29) > since ? addDays(today, -29) : since;
  const span = diffDays(today, from) + 1;
  const done = dates.filter((d) => d >= from).length;
  const s = h.schedule;
  let needed: number;
  if (s.type === "daily") needed = span;
  else if (s.type === "days") {
    needed = 0;
    for (let d = from; d <= today; d = addDays(d, 1)) if (scheduledDay(s, d)) needed++;
  } else if (s.type === "week") needed = (span / 7) * target(s);
  else if (s.type === "month") needed = (span / 30.4) * target(s);
  else needed = span / target(s);
  void weekStart;
  return { total: dates.length, rate30: needed > 0 ? Math.min(1, done / needed) : 0, since };
}

export function describeHabit(h: Habit): string {
  const k = perDayOf(h);
  const base = describeSchedule(h.schedule);
  return k > 1 ? `${base}, ${k} times a day` : base;
}

export function describeSchedule(s: HabitSchedule): string {
  const n = target(s);
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (s.type) {
    case "daily": return "Every day";
    case "days": return s.days?.length ? s.days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join(", ") : "Every day";
    case "week": return n === 1 ? "Once a week" : `${n} times a week`;
    case "month": return n === 1 ? "Once a month" : `${n} times a month`;
    case "interval": return n === 1 ? "Every day" : n === 2 ? "Every other day" : `Every ${n} days`;
  }
}

/** Day cells for a history grid: `weeks` columns ending with the current week. */
export function historyGrid(h: Habit, today: ISODate, weeks: number, weekStart = 1) {
  const end = addDays(startOfWeek(today, weekStart), 6);
  const start = addDays(end, -(weeks * 7) + 1);
  const cols: { date: ISODate; done: boolean; partial: boolean; future: boolean; scheduled: boolean }[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = fromDayNum(dayNum(start) + w * 7 + i);
      const c = countOn(h, d);
      col.push({ date: d, done: c >= perDayOf(h), partial: c > 0 && c < perDayOf(h), future: d > today, scheduled: scheduledDay(h.schedule, d) });
    }
    cols.push(col);
  }
  return cols;
}

export { prevPeriod };
