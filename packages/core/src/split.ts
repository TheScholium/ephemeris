// Split a task into sections and schedule each section on its own day.
//
// A section is a subtask. Subtasks already carry their own planned date, so the
// Today, Upcoming and Calendar views, the alarms and the recurrence engine need no
// change: each section shows on the day it is planned for.

import { addDays, diffDays, weekday, type HHMM, type ISODate } from "./dates";
import { createTask, subtasksOf, updateTask } from "./ops";
import type { Store } from "./store";
import type { Task } from "./types";

/** Most days a spread may cover. Protects against a typo such as year 2062. */
const MAX_SPAN_DAYS = 366;

export interface SpreadOptions {
  /** first day that may hold a section */
  start: ISODate;
  /** last day that may hold a section (inclusive); defaults to `start` */
  end?: ISODate | null;
  /** do not plan sections on Saturday or Sunday (ignored if that leaves no day) */
  skipWeekends?: boolean;
}

export interface SectionSpec {
  title: string;
  /** minutes; when no section has one, the parent's estimate is shared equally */
  estimate?: number | null;
  /** when omitted, the section gets a date from `spread` */
  planned?: ISODate | null;
  plannedTime?: HHMM | null;
}

/** The days a spread may use, in order. Never empty. */
export function spreadDays(opts: SpreadOptions): ISODate[] {
  const start = opts.start;
  let end = opts.end && opts.end >= start ? opts.end : start;
  if (diffDays(end, start) >= MAX_SPAN_DAYS) end = addDays(start, MAX_SPAN_DAYS - 1);
  const all: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) all.push(d);
  if (!opts.skipWeekends) return all;
  const work = all.filter((d) => {
    const w = weekday(d);
    return w !== 0 && w !== 6;
  });
  return work.length ? work : all;
}

/**
 * One date for each of `count` sections, evenly spaced from the first day to the
 * last day. The first section gets the first day. The last section gets the last day.
 * When there are more sections than days, some sections share a day.
 */
export function spreadDates(count: number, opts: SpreadOptions): ISODate[] {
  if (count <= 0) return [];
  const days = spreadDays(opts);
  if (count === 1) return [days[0]];
  return Array.from({ length: count }, (_, i) => days[Math.round((i * (days.length - 1)) / (count - 1))]);
}

/** Share `total` minutes between `count` sections. The parts add up to `total`. */
export function shareEstimate(total: number | null | undefined, count: number): (number | null)[] {
  if (!total || total <= 0 || count <= 0) return Array.from({ length: Math.max(0, count) }, () => null);
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0) || null);
}

/**
 * Split an open, top-level task into sections (new subtasks), each with its own
 * planned date. The sections copy the parent's deadline, tags, project and space.
 * The parent keeps its deadline and stops carrying a planned date, because its
 * sections now carry the plan. Returns the new sections (empty when nothing was done).
 */
export function splitTask(store: Store, id: string, specs: SectionSpec[], spread: SpreadOptions): Task[] {
  return store.batch(() => {
    const parent = store.get<Task>(id);
    if (!parent || parent.deleted || parent.status !== "open" || parent.parentId) return [];
    const list = specs.map((s) => ({ ...s, title: s.title.trim() })).filter((s) => s.title);
    if (!list.length) return [];

    const dates = spreadDates(list.length, spread);
    const shared = list.some((s) => s.estimate != null) ? null : shareEstimate(parent.estimate, list.length);
    const existing = subtasksOf(store, id);
    let order = (existing[existing.length - 1]?.order ?? 0) + 1;

    const made = list.map((s, i) =>
      createTask(store, {
        title: s.title,
        parentId: id,
        projectId: parent.projectId,
        spaceId: parent.spaceId,
        tags: [...parent.tags],
        due: parent.due,
        dueTime: parent.dueTime,
        planned: s.planned !== undefined ? s.planned : dates[i],
        plannedTime: s.plannedTime !== undefined ? s.plannedTime : parent.plannedTime,
        estimate: s.estimate !== undefined ? s.estimate : shared ? shared[i] : null,
        order: order++,
      }),
    );
    // the plan now lives in the sections; a plan on the parent would show the work twice
    updateTask(store, id, { planned: null, plannedTime: null });
    return made;
  });
}

/**
 * Give each open subtask of `id` its own planned date, evenly spread. Use it when
 * the sections already exist as subtasks. Returns the subtasks that changed.
 */
export function scheduleSubtasks(store: Store, id: string, spread: SpreadOptions): Task[] {
  return store.batch(() => {
    const parent = store.get<Task>(id);
    if (!parent || parent.deleted || parent.status !== "open") return [];
    const open = subtasksOf(store, id).filter((s) => s.status === "open");
    const dates = spreadDates(open.length, spread);
    open.forEach((s, i) => updateTask(store, s.id, { planned: dates[i] }));
    if (open.length) updateTask(store, id, { planned: null, plannedTime: null });
    return open;
  });
}

/** Ids of tasks whose plan is carried by at least one open, planned subtask. */
export function plannedThroughSections(tasks: Task[]): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) if (t.parentId && !t.deleted && t.status === "open" && t.planned) out.add(t.parentId);
  return out;
}
