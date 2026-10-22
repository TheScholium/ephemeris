// Notification schedule. The server runs this for every changed task and stores the
// resulting alarms; a cron job sends the due ones as Web Push messages.

import { addDays, fmtDuration, fmtTime12, MONTH_NAMES, parseISO, weekday, WEEKDAY_NAMES, zonedToEpoch, type HHMM, type ISODate } from "./dates";

const shortDate = (d: ISODate) => `${WEEKDAY_NAMES[weekday(d)]} ${MONTH_NAMES[parseISO(d).m - 1]} ${parseISO(d).d}`;
import { todayView, totalEstimate } from "./query";
import type { Settings, Task } from "./types";

export interface Alarm {
  id: string;
  taskId: string;
  at: number; // epoch ms
  title: string;
  body: string;
  url: string;
}

function when(date: ISODate, time: HHMM | null, s: Settings) {
  return zonedToEpoch(date, time ?? s.allDayTime, s.tz);
}

export function taskAlarms(t: Task, s: Settings, parentTitle?: string): Alarm[] {
  if (t.deleted || t.status !== "open") return [];
  const out: Alarm[] = [];
  const url = `/#/task/${t.id}`;
  const ctx = parentTitle ? ` (${parentTitle})` : "";
  const est = t.estimate ? ` · ${fmtDuration(t.estimate)}` : "";
  const dueTxt = t.due ? ` · due ${shortDate(t.due)}${t.dueTime ? ", " + fmtTime12(t.dueTime) : ""}` : "";

  const push = (kind: string, at: number, title: string, body: string) => {
    if (!Number.isFinite(at)) return;
    if (out.some((a) => a.at === at && a.title === title)) return;
    out.push({ id: `${t.id}|${kind}|${at}`, taskId: t.id, at, title, body, url });
  };

  for (const r of t.reminders ?? []) {
    if (r.at?.date) {
      push(`r${r.id}`, when(r.at.date, r.at.time ?? null, s), t.title, `Reminder${ctx}${est}${dueTxt}`);
      continue;
    }
    const anchor = r.anchor ?? "planned";
    const date = anchor === "due" ? t.due : t.planned;
    if (!date) continue;
    const time = anchor === "due" ? t.dueTime : t.plannedTime;
    const at = when(date, time, s) - (r.offset ?? 0) * 60_000;
    const lead = r.offset ? `in ${fmtDuration(r.offset)}` : "now";
    const what = anchor === "due" ? `Due ${lead}` : time ? `Planned ${lead}` : "Planned today";
    push(`r${r.id}`, at, t.title, `${what}${ctx}${est}${anchor === "planned" ? dueTxt : ""}`);
  }

  if (s.autoPlannedOffset != null && t.planned && t.plannedTime) {
    const at = when(t.planned, t.plannedTime, s) - s.autoPlannedOffset * 60_000;
    const lead = s.autoPlannedOffset ? `Starts in ${fmtDuration(s.autoPlannedOffset)}` : `Now · ${fmtTime12(t.plannedTime)}`;
    push("plan", at, t.title, `${lead}${ctx}${est}${dueTxt}`);
  }
  if (s.autoDueOffset != null && t.due && t.dueTime) {
    const at = when(t.due, t.dueTime, s) - s.autoDueOffset * 60_000;
    push("due", at, t.title, `Due ${s.autoDueOffset ? "in " + fmtDuration(s.autoDueOffset) : "now"} · ${fmtTime12(t.dueTime)}${ctx}`);
  }
  if (s.dueEveTime && t.due) {
    // the evening before the deadline, unless the task is already planned for the deadline day or earlier
    const planned = t.planned && t.planned <= addDays(t.due, -1);
    if (!planned) {
      push("eve", when(addDays(t.due, -1), s.dueEveTime, s), t.title,
        `Due tomorrow${t.dueTime ? " at " + fmtTime12(t.dueTime) : ""}${ctx}${t.planned ? "" : " · not planned yet"}`);
    }
  }
  return out;
}

/** Daily summary text, or null if there is nothing to say. */
export function digest(tasks: Task[], today: ISODate): { title: string; body: string } | null {
  const v = todayView(tasks, today);
  const planned = v.planned.length;
  const due = v.dueToday.length + v.planned.filter((t) => t.due === today).length;
  if (!planned && !due && !v.overdue.length && !v.carried.length) return null;
  const parts: string[] = [];
  if (planned) parts.push(`${planned} planned${v.load ? ` (${fmtDuration(totalEstimate(v.planned))})` : ""}`);
  if (due) parts.push(`${due} due`);
  if (v.overdue.length) parts.push(`${v.overdue.length} overdue`);
  if (v.carried.length) parts.push(`${v.carried.length} carried over`);
  const lines = [...v.overdue.map((t) => `Overdue: ${t.title}`), ...v.planned.map((t) =>
    `${t.plannedTime ? fmtTime12(t.plannedTime) + " " : ""}${t.title}`)];
  return { title: `Today: ${parts.join(", ")}`, body: lines.slice(0, 6).join("\n") };
}

