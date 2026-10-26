// Views over the task set. These functions decide what "Today" means, and they are
// where the due date / planned date distinction becomes visible.

import { addDays, addMonths, diffDays, parseHM, type ISODate } from "./dates";
import { between } from "./recurrence";
import { plannedThroughSections } from "./split";
import type { Task } from "./types";

export const isOpen = (t: Task) => t.status === "open" && !t.deleted;

export function byPlan(a: Task, b: Task): number {
  // timed tasks first, by time; then untimed by deadline, then manual order
  if (a.plannedTime && b.plannedTime) return parseHM(a.plannedTime) - parseHM(b.plannedTime);
  if (a.plannedTime) return -1;
  if (b.plannedTime) return 1;
  if (a.starred !== b.starred) return a.starred ? -1 : 1;
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (b.due && !a.due) return 1;
  return a.order - b.order;
}

export function byDue(a: Task, b: Task): number {
  if (a.due !== b.due) return (a.due ?? "9999") < (b.due ?? "9999") ? -1 : 1;
  if (a.dueTime !== b.dueTime) return (a.dueTime ?? "99") < (b.dueTime ?? "99") ? -1 : 1;
  return byPlan(a, b);
}

export interface TodayView {
  /** deadline already passed */
  overdue: Task[];
  /** planned for today */
  planned: Task[];
  /** due today but planned for another day (or not planned) */
  dueToday: Task[];
  /** planned on an earlier day and not done: the plan slipped */
  carried: Task[];
  /** a deadline within the horizon with no plan, or a plan AFTER the deadline */
  needsPlan: Task[];
  doneToday: Task[];
  /** minutes of estimated work planned for today (open + done today) */
  load: number;
  loadDone: number;
}

export function todayView(tasks: Task[], today: ISODate, horizon = 7): TodayView {
  const v: TodayView = { overdue: [], planned: [], dueToday: [], carried: [], needsPlan: [], doneToday: [], load: 0, loadDone: 0 };
  const limit = addDays(today, horizon);
  // a task split into planned sections has its plan in the sections: it does not need its own
  const sectioned = plannedThroughSections(tasks);
  for (const t of tasks) {
    if (t.deleted) continue;
    if (t.status === "done" && t.completedAt && isSameLocalDay(t.completedAt, today)) {
      v.doneToday.push(t);
      if (t.planned === today) v.loadDone += t.estimate ?? 0;
      continue;
    }
    if (t.status !== "open") continue;
    if (t.due && t.due < today) v.overdue.push(t);
    else if (t.planned === today) v.planned.push(t);
    else if (t.due === today) v.dueToday.push(t);
    else if (t.planned && t.planned < today) v.carried.push(t);
    else if (t.due && t.due <= limit && (!t.planned || t.planned > t.due) && !sectioned.has(t.id)) v.needsPlan.push(t);
    if (t.planned && t.planned <= today) v.load += t.estimate ?? 0;
  }
  v.overdue.sort(byDue);
  v.planned.sort(byPlan);
  v.dueToday.sort(byDue);
  v.carried.sort((a, b) => (a.planned! < b.planned! ? -1 : a.planned! > b.planned! ? 1 : byPlan(a, b)));
  v.needsPlan.sort(byDue);
  v.doneToday.sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1));
  v.load += v.loadDone;
  return v;
}

function isSameLocalDay(iso: string, day: ISODate): boolean {
  // completedAt is an instant; compare against the device's local calendar day
  const d = new Date(iso);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return local === day;
}

/** A future occurrence of a recurring task. Only one instance exists at a time, so these are projections. */
export interface Ghost {
  task: Task;
  date: ISODate;
  kind: "planned" | "due";
}

export function repeatGhosts(tasks: Task[], from: ISODate, to: ISODate): Ghost[] {
  const out: Ghost[] = [];
  for (const t of tasks) {
    const r = t.recurrence;
    if (!r || !isOpen(t) || t.parentId) continue;
    const A = t.due ?? t.planned;
    if (!A) continue;
    const off = t.due && t.planned ? diffDays(t.planned, t.due) : null;
    let dates: ISODate[];
    const limit = r.count ? Math.max(0, r.count - (t.occurrence || 1)) : 400;
    if (r.mode === "completion") {
      // assume each one is done on its day
      dates = [];
      let d = A;
      const n = Math.max(1, r.interval || 1);
      for (let i = 0; i < limit && dates.length < 400; i++) {
        d = r.freq === "daily" ? addDays(d, n) : r.freq === "weekly" ? addDays(d, 7 * n) : addMonths(d, r.freq === "monthly" ? n : 12 * n);
        if (d > addDays(to, 1) || (r.until && d > r.until)) break;
        dates.push(d);
      }
    } else {
      dates = between({ ...r, count: null }, addDays(A, 1), addDays(to, Math.abs(off ?? 0)), limit);
    }
    for (const d of dates) {
      const due = t.due ? d : null;
      const planned = t.due ? (off !== null ? addDays(d, off) : null) : d;
      if (planned && planned >= from && planned <= to) out.push({ task: t, date: planned, kind: "planned" });
      if (due && due !== planned && due >= from && due <= to) out.push({ task: t, date: due, kind: "due" });
    }
  }
  return out;
}

export interface DayPlan {
  date: ISODate;
  /** projected occurrences of recurring tasks */
  ghosts: Ghost[];
  planned: Task[];
  /** tasks whose deadline is this day but that are planned for some other day (or none) */
  deadlines: Task[];
  load: number;
}

export function upcoming(tasks: Task[], from: ISODate, days: number): DayPlan[] {
  const out: DayPlan[] = [];
  const idx = new Map<ISODate, DayPlan>();
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const p: DayPlan = { date: d, ghosts: [], planned: [], deadlines: [], load: 0 };
    out.push(p);
    idx.set(d, p);
  }
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    if (t.planned && idx.has(t.planned)) {
      const p = idx.get(t.planned)!;
      p.planned.push(t);
      p.load += t.estimate ?? 0;
    }
    if (t.due && idx.has(t.due) && t.planned !== t.due) idx.get(t.due)!.deadlines.push(t);
  }
  for (const g of repeatGhosts(tasks, from, addDays(from, days - 1))) {
    const p = idx.get(g.date);
    if (!p) continue;
    p.ghosts.push(g);
    if (g.kind === "planned") p.load += g.task.estimate ?? 0;
  }
  out.forEach((p) => {
    p.ghosts.sort((a, b) => byPlan(a.task, b.task));
    p.planned.sort(byPlan);
    p.deadlines.sort(byDue);
  });
  return out;
}

/** Open top-level tasks with no dates and no project. */
export function inbox(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => isOpen(t) && !t.parentId && !t.planned && !t.due && !t.projectId)
    .sort((a, b) => b.order - a.order);
}

/** Open tasks with no planned date (planning backlog), deadlines first. */
export function unplanned(tasks: Task[]): Task[] {
  const sectioned = plannedThroughSections(tasks);
  return tasks.filter((t) => isOpen(t) && !t.planned && !t.parentId && !sectioned.has(t.id)).sort(byDue);
}

export interface Filter {
  text?: string;
  tags?: string[];
  tagMode?: "any" | "all";
  projectId?: string | null;
  spaceId?: string | null;
  status?: "open" | "done" | "all";
  has?: "due" | "planned" | "none" | "estimate" | null;
  starred?: boolean;
  includeSubtasks?: boolean;
}

export const tagMatches = (taskTag: string, wanted: string) => taskTag === wanted || taskTag.startsWith(wanted + "/");

export function filterTasks(tasks: Task[], f: Filter): Task[] {
  const text = f.text?.trim().toLowerCase();
  return tasks.filter((t) => {
    if (t.deleted) return false;
    const st = f.status ?? "open";
    if (st === "open" && t.status !== "open") return false;
    if (st === "done" && t.status === "open") return false;
    if (!f.includeSubtasks && t.parentId && !text && !f.tags?.length) return false;
    if (f.projectId !== undefined && f.projectId !== null && t.projectId !== f.projectId) return false;
    if (f.spaceId && t.spaceId !== f.spaceId) return false;
    if (f.starred && !t.starred) return false;
    if (f.tags?.length) {
      const hit = (w: string) => t.tags.some((x) => tagMatches(x, w));
      if ((f.tagMode ?? "any") === "all" ? !f.tags.every(hit) : !f.tags.some(hit)) return false;
    }
    if (f.has === "due" && !t.due) return false;
    if (f.has === "planned" && !t.planned) return false;
    if (f.has === "none" && (t.due || t.planned)) return false;
    if (f.has === "estimate" && !t.estimate) return false;
    if (text) {
      const hay = `${t.title} ${t.notes} ${t.tags.join(" ")}`.toLowerCase();
      if (!text.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** All tags with counts of open tasks, including parent paths of nested tags. */
export function tagCounts(tasks: Task[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (t.deleted) continue;
    for (const tag of t.tags) {
      const parts = tag.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const k = parts.slice(0, i).join("/");
        if (!m.has(k)) m.set(k, 0);
        if (t.status === "open") m.set(k, m.get(k)! + 1);
      }
    }
  }
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function logbook(tasks: Task[], limit = 300): Task[] {
  return tasks
    .filter((t) => !t.deleted && t.status !== "open" && t.completedAt)
    .sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1))
    .slice(0, limit);
}

export const totalEstimate = (ts: Task[]) => ts.reduce((s, t) => s + (t.estimate ?? 0), 0);

/** Task is planned after its own deadline: a planning error worth flagging. */
export const planAfterDue = (t: Task) => !!(t.planned && t.due && t.planned > t.due);

export const daysLate = (t: Task, today: ISODate) => (t.due && t.due < today ? diffDays(today, t.due) : 0);
