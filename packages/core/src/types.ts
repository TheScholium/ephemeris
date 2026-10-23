import type { HHMM, ISODate } from "./dates";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export const WEEKDAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]; // index = JS getDay()

export interface Recurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number; // >= 1
  /** weekly: which weekdays; daily: optional filter (e.g. weekdays only) */
  byDay?: Weekday[];
  /** monthly/yearly: nth weekday of the month, n in 1..5 or -1 (last) */
  byNthDay?: { day: Weekday; n: number }[];
  /** monthly/yearly: day of month, negative counts from the end (-1 = last day) */
  byMonthDay?: number[];
  /** yearly: months 1..12 */
  byMonth?: number[];
  /**
   * schedule:   next date follows the fixed pattern (every Monday).
   * completion: next date counts from the day the task is completed (3 days after done).
   */
  mode: "schedule" | "completion";
  /** first date of the series; the pattern phase (week parity, etc.) comes from it */
  start: ISODate;
  until?: ISODate | null;
  count?: number | null;
}

export type ReminderAnchor = "planned" | "due";
export interface Reminder {
  id: string;
  /** Relative reminder: minutes before the anchor time (0 = at the time). */
  anchor?: ReminderAnchor;
  offset?: number;
  /** Absolute reminder: local wall date + time. */
  at?: { date: ISODate; time: HHMM } | null;
}

export interface Link {
  url: string;
  title?: string;
}
export interface Place {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
}
export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export type Status = "open" | "done" | "dropped";

interface Base {
  id: string;
  /** per-field hybrid logical clocks for merging */
  _c: Record<string, string>;
  deleted?: boolean;
  createdAt: string;
}

export interface Task extends Base {
  kind: "task";
  title: string;
  notes: string;
  status: Status;
  /** Deadline: the day it must be done by. */
  due: ISODate | null;
  dueTime: HHMM | null;
  /** Plan: the day (and optional time) I intend to work on it. */
  planned: ISODate | null;
  plannedTime: HHMM | null;
  /** minutes */
  estimate: number | null;
  tags: string[];
  projectId: string | null;
  spaceId: string | null;
  parentId: string | null;
  order: number;
  links: Link[];
  location: Place | null;
  attachments: Attachment[];
  reminders: Reminder[];
  recurrence: Recurrence | null;
  seriesId: string | null;
  occurrence: number;
  completedAt: string | null;
  starred: boolean;
}

export interface Project extends Base {
  kind: "project";
  name: string;
  spaceId: string | null;
  color: string;
  order: number;
  archived: boolean;
  notes: string;
}

export interface Space extends Base {
  kind: "space";
  name: string;
  color: string;
  order: number;
}

export interface CalendarFeed {
  name: string;
  url: string;
  color: string;
}

export interface Settings extends Base {
  kind: "settings";
  tz: string;
  weekStart: number; // 0 Sunday, 1 Monday
  /** daily summary notification */
  digestEnabled: boolean;
  digestTime: HHMM;
  /** automatic reminder at a planned time (minutes before), null = off */
  autoPlannedOffset: number | null;
  /** automatic reminder before a timed deadline */
  autoDueOffset: number | null;
  /** automatic reminder the day before an all-day deadline, at this time; null = off */
  dueEveTime: HHMM | null;
  /** time used for relative reminders on tasks that have a date but no time */
  allDayTime: HHMM;
  /** export tasks to the calendar feed */
  icsIncludeDue: boolean;
  /** external calendars shown beside tasks (fetched through the server) */
  feeds: CalendarFeed[];
  dayStart: HHMM;
  dayEnd: HHMM;
}

/**
 * How often a habit is due.
 *  daily     every day
 *  days      specific weekdays (days: 0 = Sunday ... 6 = Saturday)
 *  week      n times per week (any days)
 *  month     n times per calendar month
 *  interval  at least once every n days ("every other day" = 2)
 */
export interface HabitSchedule {
  type: "daily" | "days" | "week" | "month" | "interval";
  n?: number;
  days?: number[];
}

/**
 * A habit. Check-ins are stored as one field per day, `d:YYYY-MM-DD` = 1 (done) or 0
 * (undone), so each day merges on its own clock and offline check-ins on two devices
 * never overwrite each other.
 */
export interface Habit extends Base {
  kind: "habit";
  name: string;
  /** one or two characters shown in the circle */
  glyph: string;
  schedule: HabitSchedule;
  order: number;
  archived: boolean;
  [day: `d:${string}`]: number;
}

export type Rec = Task | Project | Space | Settings | Habit;
export type Kind = Rec["kind"];

export const SETTINGS_ID = "settings";

/** Fields that carry clocks (everything the user can change). */
export const TASK_FIELDS = [
  "title", "notes", "status", "due", "dueTime", "planned", "plannedTime", "estimate",
  "tags", "projectId", "spaceId", "parentId", "order", "links", "location", "attachments",
  "reminders", "recurrence", "seriesId", "occurrence", "completedAt", "starred", "deleted",
] as const;
