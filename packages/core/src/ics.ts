// iCalendar in both directions.
//  - buildICS: planned tasks (and deadlines) as a feed that Apple Calendar or
//    Google Calendar can subscribe to, so the plan sits beside normal events.
//  - parseICS: read a calendar's secret iCal address so its events show inside
//    the task calendar view while planning.

import { addDays, epochToZoned, fromDayNum, dayNum, isISODate, pad, parseISO, toISO, zonedToEpoch, type HHMM, type ISODate } from "./dates";
import { between } from "./recurrence";
import type { Recurrence, Settings, Task, Weekday } from "./types";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function fold(line: string): string {
  // RFC 5545: lines longer than 75 octets are folded with CRLF + space
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const l = new TextEncoder().encode(ch).length;
    if (curLen + l > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += l;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const utcStamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const dateVal = (d: ISODate) => d.replace(/-/g, "");

export function buildICS(tasks: Task[], s: Settings, appUrl = ""): string {
  const L: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ephemeris//Tasks//EN", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:Ephemeris", "X-WR-TIMEZONE:" + s.tz,
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  const stamp = utcStamp(Date.now());
  const event = (uid: string, title: string, date: ISODate, time: HHMM | null, mins: number, desc: string, url: string) => {
    L.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`);
    if (time) {
      const start = zonedToEpoch(date, time, s.tz);
      L.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(start + mins * 60_000)}`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${dateVal(date)}`, `DTEND;VALUE=DATE:${dateVal(addDays(date, 1))}`);
      L.push("TRANSP:TRANSPARENT");
    }
    L.push(fold(`SUMMARY:${esc(title)}`));
    if (desc) L.push(fold(`DESCRIPTION:${esc(desc)}`));
    if (url) L.push(fold(`URL:${url}`));
    L.push("END:VEVENT");
  };
  for (const t of tasks) {
    if (t.deleted || t.status !== "open") continue;
    const url = appUrl ? `${appUrl}/#/task/${t.id}` : "";
    const meta = [
      t.due ? `Due ${t.due}${t.dueTime ? " " + t.dueTime : ""}` : "",
      t.estimate ? `Estimate ${t.estimate} min` : "",
      t.tags.length ? t.tags.map((x) => "#" + x).join(" ") : "",
    ].filter(Boolean).join(" · ");
    if (t.planned) {
      event(`${t.id}-plan@ephemeris`, t.title, t.planned, t.plannedTime, t.estimate || 30,
        [meta, t.notes].filter(Boolean).join("\n\n"), url);
    }
    if (s.icsIncludeDue && t.due && t.due !== t.planned) {
      event(`${t.id}-due@ephemeris`, `Due: ${t.title}`, t.due, t.dueTime, 15, t.notes, url);
    }
  }
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}

// ---------- import ----------

export interface CalEvent {
  uid: string;
  title: string;
  location?: string;
  allDay: boolean;
  /** local (display zone) */
  date: ISODate;
  start?: HHMM;
  /** minutes */
  duration: number;
  endDate: ISODate;
  calendar?: string;
  color?: string;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=VAL;PARAM="V:AL":VALUE
  let i = 0;
  let inQ = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ":" && !inQ) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...ps] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of ps) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

const unesc = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

interface Stamp {
  date: ISODate;
  time: HHMM | null;
  /** zone of the wall time, "UTC" for Z values, null for floating */
  tz: string | null;
}

function parseStamp(p: Prop): Stamp | null {
  const v = p.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isISODate(date)) return null;
  if (!m[4] || p.params.VALUE === "DATE") return { date, time: null, tz: null };
  return { date, time: `${m[4]}:${m[5]}`, tz: m[7] ? "UTC" : validZone(p.params.TZID) };
}

const zoneOk = new Map<string, boolean>();
function validZone(tz?: string): string | null {
  if (!tz) return null;
  const clean = tz.replace(/^\/[^/]*\/[^/]*\//, ""); // "/mozilla.org/20050126_1/America/New_York"
  if (!zoneOk.has(clean)) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: clean });
      zoneOk.set(clean, true);
    } catch {
      zoneOk.set(clean, false);
    }
  }
  return zoneOk.get(clean) ? clean : null;
}

function parseDuration(v: string): number {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, , w, d, h, mi] = m;
  return (Number(w || 0) * 7 + Number(d || 0)) * 1440 + Number(h || 0) * 60 + Number(mi || 0);
}

const FREQ: Record<string, Recurrence["freq"]> = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };

export function rruleToRecurrence(rrule: string, start: ISODate): Recurrence | null {
  const parts: Record<string, string> = {};
  for (const kv of rrule.split(";")) {
    const [k, v] = kv.split("=");
    if (k && v) parts[k.toUpperCase()] = v;
  }
  const freq = FREQ[parts.FREQ];
  if (!freq) return null;
  const r: Recurrence = { freq, interval: Number(parts.INTERVAL || 1), mode: "schedule", start };
  if (parts.COUNT) r.count = Number(parts.COUNT);
  if (parts.UNTIL) {
    const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) r.until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (parts.BYDAY) {
    for (const d of parts.BYDAY.split(",")) {
      const m = d.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/);
      if (!m) continue;
      if (m[1] && (freq === "monthly" || freq === "yearly")) (r.byNthDay ||= []).push({ day: m[2] as Weekday, n: Number(m[1]) });
      else (r.byDay ||= []).push(m[2] as Weekday);
    }
    // monthly BYDAY without ordinal (every Tuesday of the month) ~ weekly
    if ((freq === "monthly" || freq === "yearly") && r.byDay?.length && !r.byNthDay?.length) {
      r.byNthDay = r.byDay.flatMap((day) => [1, 2, 3, 4, 5].map((n) => ({ day, n })));
      delete r.byDay;
    }
    if (parts.BYSETPOS && r.byNthDay?.length && freq === "monthly") {
      const pos = Number(parts.BYSETPOS);
      const days = [...new Set(r.byNthDay.map((x) => x.day))];
      if (days.length === 1) r.byNthDay = [{ day: days[0], n: pos }];
    }
  }
  if (parts.BYMONTHDAY) r.byMonthDay = parts.BYMONTHDAY.split(",").map(Number).filter(Boolean);
  if (parts.BYMONTH) r.byMonth = parts.BYMONTH.split(",").map(Number).filter(Boolean);
  return r;
}

/**
 * Events overlapping [from, to] (local dates in `tz`), with recurring events expanded,
 * EXDATEs removed and RECURRENCE-ID overrides applied.
 */
export function parseICS(text: string, from: ISODate, to: ISODate, tz: string): CalEvent[] {
  const lines = unfold(text);
  type Raw = { props: Prop[]; exdates: string[] };
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { props: [], exdates: [] };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:") && line !== "END:VEVENT") depth--;
    else if (line === "END:VEVENT") {
      raws.push(cur);
      cur = null;
      continue;
    }
    if (depth > 0) continue; // skip VALARM etc.
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "EXDATE") p.value.split(",").forEach((v) => cur!.exdates.push(v.slice(0, 8)));
    else cur.props.push(p);
  }

  const toLocal = (st: Stamp): { date: ISODate; time: HHMM | null } => {
    if (!st.time) return { date: st.date, time: null };
    if (!st.tz) return st; // floating time: show as written
    return epochToZoned(zonedToEpoch(st.date, st.time, st.tz), tz);
  };

  const overrides = new Map<string, Set<string>>(); // uid -> dates (YYYYMMDD) replaced
  const out: CalEvent[] = [];
  const fromN = dayNum(from);
  const toN = dayNum(to);

  type Ev = { uid: string; title: string; location?: string; start: Stamp; durMin: number; allDay: boolean; rrule?: string; exdates: string[]; recurId?: string; cancelled: boolean };
  const evs: Ev[] = [];
  for (const r of raws) {
    const get = (n: string) => r.props.find((p) => p.name === n);
    const ds = get("DTSTART");
    const start = ds && parseStamp(ds);
    if (!start) continue;
    let durMin = 0;
    const de = get("DTEND");
    const end = de && parseStamp(de);
    const allDay = !start.time;
    if (end) {
      if (allDay) durMin = (dayNum(end.date) - dayNum(start.date)) * 1440;
      else {
        const a = zonedToEpoch(start.date, start.time!, start.tz ?? tz);
        const b = zonedToEpoch(end.date, end.time ?? "00:00", end.tz ?? start.tz ?? tz);
        durMin = Math.round((b - a) / 60000);
      }
    } else if (get("DURATION")) durMin = parseDuration(get("DURATION")!.value);
    else durMin = allDay ? 1440 : 0;
    const uid = get("UID")?.value ?? Math.random().toString(36);
    const rid = get("RECURRENCE-ID");
    const ev: Ev = {
      uid,
      title: unesc(get("SUMMARY")?.value ?? "(no title)"),
      location: get("LOCATION") ? unesc(get("LOCATION")!.value) : undefined,
      start, durMin, allDay,
      rrule: get("RRULE")?.value,
      exdates: r.exdates,
      recurId: rid ? rid.value.slice(0, 8) : undefined,
      cancelled: (get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
    };
    if (ev.recurId) {
      if (!overrides.has(uid)) overrides.set(uid, new Set());
      overrides.get(uid)!.add(ev.recurId);
    }
    evs.push(ev);
  }

  const emit = (ev: Ev, date: ISODate) => {
    const local = toLocal({ ...ev.start, date });
    const endDay = ev.allDay
      ? fromDayNum(dayNum(local.date) + Math.max(1, Math.round(ev.durMin / 1440)) - 1)
      : epochToZoned(zonedToEpoch(local.date, local.time!, tz) + ev.durMin * 60000, tz).date;
    if (dayNum(endDay) < fromN || dayNum(local.date) > toN) return;
    out.push({
      uid: ev.uid + "@" + date, title: ev.title, location: ev.location, allDay: ev.allDay,
      date: local.date, start: local.time ?? undefined, duration: ev.durMin, endDate: endDay,
    });
  };

  for (const ev of evs) {
    if (ev.cancelled) continue;
    if (ev.recurId || !ev.rrule) {
      emit(ev, ev.start.date);
      continue;
    }
    const rule = rruleToRecurrence(ev.rrule, ev.start.date);
    if (!rule) {
      emit(ev, ev.start.date);
      continue;
    }
    const skip = new Set([...ev.exdates, ...(overrides.get(ev.uid) ?? [])]);
    // expand in the event's own zone; widen the window by a day for zone shifts and multi-day events
    const spanDays = Math.ceil(ev.durMin / 1440) + 1;
    for (const d of between(rule, addDays(from, -spanDays), addDays(to, 1), 1000)) {
      if (!skip.has(d.replace(/-/g, ""))) emit(ev, d);
    }
  }
  return out.sort((a, b) => (a.date + (a.start ?? "")).localeCompare(b.date + (b.start ?? "")));
}

export { toISO, parseISO };
