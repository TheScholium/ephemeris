// Natural-language quick add.
//
//   "Read Lee ch. 3 tomorrow 9am for 90m due fri #drp +Riemannian"
//   -> title "Read Lee ch. 3", planned tomorrow 09:00, estimate 90, due Friday,
//      tags [drp], project "Riemannian"
//
// Rules of the grammar (also shown in the app's help):
//   due / by / before <date>   -> deadline           "due fri 5pm", "by oct 30"
//   <date> [at <time>]         -> planned date       "tomorrow 9am", "on mon", "next fri"
//   at <time> / 3-5pm          -> planned time (and duration for a range)
//   for 45m / ~1h30 / (2h)     -> time estimate
//   every ... / daily / weekly -> recurrence         "every mon, wed", "every 2 weeks",
//                                                    "every month on the last fri",
//                                                    "every 3 days after done"
//   #tag  +Project  !          -> tag, project (use _ for spaces), star
//   remind 15m before          -> reminder
//   "quoted text"              -> never parsed

import {
  addDays, addMonths, daysInMonth, diffDays, fmtHM, parseISO, startOfWeek, toISO, weekday,
  type HHMM, type ISODate,
} from "./dates";
import { normalizeRule, firstOnOrAfter } from "./recurrence";
import { WEEKDAYS as WEEKDAY_CODES, type Recurrence, type Weekday } from "./types";

export interface ParseContext {
  today: ISODate;
  /** minutes since local midnight, used to roll a bare past time to tomorrow */
  nowMinutes?: number;
  weekStart?: number;
}

export type SpanKind = "tag" | "project" | "planned" | "due" | "estimate" | "repeat" | "remind" | "star";
export interface Span {
  start: number;
  end: number;
  kind: SpanKind;
  text: string;
}

export interface Parsed {
  title: string;
  planned: ISODate | null;
  plannedTime: HHMM | null;
  due: ISODate | null;
  dueTime: HHMM | null;
  estimate: number | null;
  tags: string[];
  project: string | null;
  recurrence: Recurrence | null;
  reminders: { anchor: "planned" | "due"; offset: number }[];
  starred: boolean;
  spans: Span[];
}

// ---------- vocabulary ----------

const WD_FULL = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const WD_SAFE = "mon|tues|tue|thurs|thur|thu|fri";
const WD_AMBIG = "weds|wed|sat|sun"; // English words too: only after a keyword
const WD_ANY = `${WD_FULL}|${WD_SAFE}|${WD_AMBIG}`;
const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const ORD = "\\d{1,2}(?:st|nd|rd|th)?";
const NUMW = "\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, other: 2,
};
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()] ?? NaN);

const WD_MAP: Record<string, Weekday> = {
  mon: "MO", monday: "MO", tue: "TU", tues: "TU", tuesday: "TU", wed: "WE", weds: "WE",
  wednesday: "WE", thu: "TH", thur: "TH", thurs: "TH", thursday: "TH", fri: "FR", friday: "FR",
  sat: "SA", saturday: "SA", sun: "SU", sunday: "SU",
};
const WD_IDX: Record<Weekday, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MONTH_MAP: Record<string, number> = {};
MONTHS.split("|").forEach((m) => {
  const full = ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"];
  const i = full.findIndex((f) => f.startsWith(m.slice(0, 3)));
  MONTH_MAP[m] = i + 1;
});

function dateSrc(allowAmbiguous: boolean) {
  // allowAmbiguous: the phrase follows a keyword (on, due, by ...), so words that are
  // also ordinary English ("sun", "sat", "weekend", "the 2nd", "3/4") are safe to read as dates.
  const wd = allowAmbiguous ? WD_ANY : `${WD_FULL}|${WD_SAFE}`;
  const parts = [
    "today", "tonight", "tomorrow", "tmrw", "tmr", "tmw", "yesterday",
    `(?:this|next)\\s+(?:${WD_ANY})\\b`,
    `(?:${wd})\\b`,
    `in\\s+(?:${NUMW})\\s+(?:days?|weeks?|months?|years?)\\b`,
    "next\\s+(?:week|month|year|weekend)\\b",
    "this\\s+weekend\\b",
    "end\\s+of\\s+(?:the\\s+)?(?:week|month)\\b", "eow\\b", "eom\\b",
    `(?:${MONTHS})\\.?\\s+${ORD}(?:,?\\s+\\d{4})?\\b`,
    `${ORD}\\s+(?:of\\s+)?(?:${MONTHS})\\b(?:,?\\s+\\d{4})?`,
    "\\d{1,2}/\\d{1,2}/\\d{2,4}\\b",
    "\\d{4}-\\d{2}-\\d{2}\\b",
  ];
  if (allowAmbiguous) parts.push("tod\\b", "weekend\\b", "\\d{1,2}/\\d{1,2}\\b", "the\\s+\\d{1,2}(?:st|nd|rd|th)\\b");
  return parts.join("|");
}
const DATE_ANY = dateSrc(true);
const DATE_LOOSE = dateSrc(false);
const TIME_SRC =
  "(?:(?:at|@)\\s*)?(?:\\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)|[ap])\\b|\\d{1,2}:\\d{2}\\b|noon\\b|midnight\\b)" +
  "|(?:at|@)\\s*\\d{1,2}\\b";
const PART_SRC = "morning|afternoon|evening|night";
const PART_TIME: Record<string, HHMM> = { morning: "09:00", afternoon: "14:00", evening: "18:00", night: "20:00" };

// ---------- resolution helpers ----------

function resolveTime(raw: string): HHMM | null {
  const s = raw.toLowerCase().replace(/^(at|@)\s*/, "").replace(/\./g, "").trim();
  if (s === "noon") return "12:00";
  if (s === "midnight") return "00:00";
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (mi > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "p" && h !== 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
  } else if (!m[2]) {
    // "at 3": guess daytime hours (1-6 -> PM, 7-11 -> AM)
    if (h >= 1 && h <= 6) h += 12;
  }
  if (h > 23) return null;
  return fmtHM(h * 60 + mi);
}

function nextWeekday(today: ISODate, wd: number, strict = true): ISODate {
  let n = (wd - weekday(today) + 7) % 7;
  if (n === 0 && strict) n = 7;
  return addDays(today, n);
}

export function resolveDate(raw: string, ctx: ParseContext): ISODate | null {
  const t = ctx.today;
  const ws = ctx.weekStart ?? 1;
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  let m: RegExpMatchArray | null;

  if (s === "today" || s === "tod" || s === "tonight") return t;
  if (["tomorrow", "tmrw", "tmr", "tmw"].includes(s)) return addDays(t, 1);
  if (s === "yesterday") return addDays(t, -1);

  if ((m = s.match(/^(this|next) (\w+)$/)) && WD_MAP[m[2]]) {
    const wd = WD_IDX[WD_MAP[m[2]]];
    const weekBase = startOfWeek(t, ws);
    const off = (wd - ws + 7) % 7;
    if (m[1] === "next") return addDays(weekBase, 7 + off);
    const d = addDays(weekBase, off);
    return d >= t ? d : nextWeekday(t, wd);
  }
  if (WD_MAP[s]) return nextWeekday(t, WD_IDX[WD_MAP[s]]);

  if ((m = s.match(/^in (\w+) (day|week|month|year)s?$/))) {
    const n = toNum(m[1]);
    if (!Number.isFinite(n)) return null;
    if (m[2] === "day") return addDays(t, n);
    if (m[2] === "week") return addDays(t, 7 * n);
    if (m[2] === "month") return addMonths(t, n);
    return addMonths(t, 12 * n);
  }
  if (s === "next week") return addDays(startOfWeek(t, ws), 7);
  if (s === "next month") {
    const { y, m: mo } = parseISO(addMonths(t, 1));
    return toISO(y, mo, 1);
  }
  if (s === "next year") return toISO(parseISO(t).y + 1, 1, 1);
  if (s === "weekend" || s === "this weekend") {
    const wd = weekday(t);
    return wd === 6 || wd === 0 ? t : nextWeekday(t, 6);
  }
  if (s === "next weekend") return addDays(nextWeekday(t, 6, false), 7);
  if (s === "eow" || /^end of (the )?week$/.test(s)) {
    const fri = nextWeekday(t, 5, false);
    return fri;
  }
  if (s === "eom" || /^end of (the )?month$/.test(s)) {
    const { y, m: mo } = parseISO(t);
    return toISO(y, mo, daysInMonth(y, mo));
  }

  const fixYear = (y: number | null, mo: number, d: number): ISODate | null => {
    const ty = parseISO(t).y;
    if (mo < 1 || mo > 12) return null;
    let yy = y ?? ty;
    if (yy < 100) yy += 2000;
    if (d < 1 || d > daysInMonth(yy, mo)) return null;
    let iso = toISO(yy, mo, d);
    if (y == null && diffDays(t, iso) > 31) iso = toISO(yy + 1, mo, Math.min(d, daysInMonth(yy + 1, mo)));
    return iso;
  };

  if ((m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/)) && MONTH_MAP[m[1]])
    return fixYear(m[3] ? Number(m[3]) : null, MONTH_MAP[m[1]], Number(m[2]));
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?:,? (\d{4}))?$/)) && MONTH_MAP[m[2]])
    return fixYear(m[3] ? Number(m[3]) : null, MONTH_MAP[m[2]], Number(m[1]));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)))
    return fixYear(m[3] ? Number(m[3]) : null, Number(m[1]), Number(m[2]));
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return fixYear(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = s.match(/^the (\d{1,2})(?:st|nd|rd|th)$/))) {
    const d = Number(m[1]);
    const { y, m: mo } = parseISO(t);
    if (d <= daysInMonth(y, mo) && toISO(y, mo, d) >= t) return toISO(y, mo, d);
    const n = parseISO(addMonths(toISO(y, mo, 1), 1));
    return d <= daysInMonth(n.y, n.m) ? toISO(n.y, n.m, d) : null;
  }
  return null;
}

function parseDuration(raw: string): number | null {
  const s = raw.toLowerCase();
  if (/half an hour/.test(s)) return 30;
  if (/^(for )?an? hour$/.test(s.trim())) return 60;
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)?/g;
  let m: RegExpExecArray | null;
  let lastUnit = "";
  while ((m = re.exec(s))) {
    const v = Number(m[1]);
    let unit = (m[2] || "")[0] || "";
    if (!unit) unit = lastUnit === "h" ? "m" : "";
    if (!unit) continue;
    total += unit === "h" ? v * 60 : v;
    lastUnit = unit;
    found = true;
  }
  return found && total > 0 ? Math.round(total) : null;
}

// ---------- the parser ----------

export function parseTask(input: string, ctx: ParseContext, knownProjects: string[] = []): Parsed {
  const out: Parsed = {
    title: "", planned: null, plannedTime: null, due: null, dueTime: null, estimate: null,
    tags: [], project: null, recurrence: null, reminders: [], starred: false, spans: [],
  };
  // `work` is what the matchers see; consumed or quoted ranges become spaces / placeholders.
  const chars = input.split("");
  const consumed = new Array(input.length).fill(false);
  const work = () => chars.join("");

  // Quoted text is protected: replace letters so no rule can match inside it.
  input.replace(/"([^"]*)"/g, (all, _inner, off: number) => {
    for (let i = off; i < off + all.length; i++) chars[i] = "⁠";
    return all;
  });

  const take = (start: number, end: number, kind: SpanKind | null) => {
    for (let i = start; i < end; i++) {
      consumed[i] = true;
      chars[i] = " ";
    }
    if (kind) out.spans.push({ start, end, kind, text: input.slice(start, end) });
  };

  /** run a global regex over the current work string; callback returns false to skip */
  const scan = (re: RegExp, fn: (m: RegExpExecArray, start: number, end: number) => SpanKind | null | false) => {
    const w = work();
    re.lastIndex = 0;
    const hits: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(w))) {
      hits.push(m);
      if (m[0].length === 0) re.lastIndex++;
    }
    for (const h of hits) {
      const lead = h[1] && /^\s+$/.test(h[1]) ? h[1].length : 0;
      const start = h.index + lead;
      const end = h.index + h[0].replace(/\s+$/, "").length;
      if (consumed.slice(start, end).some((c, i) => c && !/\s/.test(input[start + i]))) continue;
      const kind = fn(h, start, end);
      if (kind !== false) take(start, end, kind);
    }
  };

  // 1. tags
  scan(/(^|\s)#([^\s#,;"]+)/g, (m) => {
    const tag = m[2].replace(/[.,:;!?)]+$/, "");
    if (!tag) return false;
    if (!out.tags.includes(tag)) out.tags.push(tag);
    return "tag";
  });

  // 2. project (+Name, +Long_Name)
  scan(/(^|\s)\+([^\s+#"]+)/g, (m) => {
    const raw = m[2].replace(/[.,:;!?)]+$/, "").replace(/_/g, " ");
    const hit = knownProjects.find((p) => p.toLowerCase() === raw.toLowerCase())
      ?? knownProjects.find((p) => p.toLowerCase().startsWith(raw.toLowerCase()));
    out.project = hit ?? raw;
    return "project";
  });

  // 3. star
  scan(/(^|\s)!(?=\s|$)/g, () => {
    out.starred = true;
    return "star";
  });

  // 4. reminders
  scan(/(^|\s)(?:remind(?:\s+me)?|alert|notify)(?:\s+(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\s+(?:before|early|prior))?(?=\s|$)/gi, (m) => {
    let off = 0;
    if (m[2]) {
      const v = Number(m[2]);
      const u = m[3].toLowerCase()[0];
      off = u === "h" ? v * 60 : u === "d" ? v * 1440 : v;
    }
    out.reminders.push({ anchor: "planned", offset: off });
    return "remind";
  });

  // 5. estimate
  scan(/(^|\s)(?:for\s+half\s+an\s+hour|for\s+an?\s+hour|(?:for|~|est\.?|estimate)\s*(?:\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?)(?![a-z])\s*){1,2}(?:\d+\b)?|\(\s*(?:\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?)\s*){1,2}\))/gi, (m) => {
    const v = parseDuration(m[0].replace(/^\s*(for|~|est\.?|estimate)\s*/i, "").replace(/[()]/g, "") || m[0]);
    if (v == null) return false;
    out.estimate = v;
    return "estimate";
  });

  // 6. time range "3-5pm", "from 2:30 to 4pm"
  let rangeTime: HHMM | null = null;
  scan(/(^|\s)(?:from\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?(?=\s|$|[,.;])/gi, (m) => {
    const endAp = m[5]?.toLowerCase();
    const startAp = m[3]?.toLowerCase();
    if (!endAp && !startAp && !(m[2].includes(":") && m[4].includes(":"))) return false;
    const e = resolveTime(m[4] + (endAp ?? ""));
    let s = resolveTime(m[2] + (startAp ?? endAp ?? ""));
    if (!s || !e) return false;
    let sm = Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const em = Number(e.slice(0, 2)) * 60 + Number(e.slice(3));
    if (!startAp && sm > em && sm - 720 >= 0) sm -= 720; // "11-1pm" -> 11am
    s = fmtHM(sm);
    if (em <= sm) return false;
    rangeTime = s;
    if (out.estimate == null) out.estimate = em - sm;
    return "planned";
  });

  // 7. recurrence
  let repeatAnchorDue = false;
  let repeatStart: ISODate | null = null;
  // "every ..." wins over a bare "daily"/"weekly" (which may just be part of the title)
  for (const re of [/(^|\s)(due\s+)?(every)\b/gi, /(^|\s)(due\s+)?(daily|weekly|monthly|yearly|annually)\b/gi]) {
    if (out.recurrence) break;
    const w = work();
    let m: RegExpExecArray | null;
    while ((m = re.exec(w))) {
      const start = m.index + m[1].length;
      const kwEnd = m.index + m[0].length;
      const res = parseRecurrenceTail(w, kwEnd, m[3].toLowerCase(), ctx);
      if (!res) continue;
      out.recurrence = res.rule;
      if (m[2]) repeatAnchorDue = true;
      if (res.until) out.recurrence.until = res.until;
      if (res.count) out.recurrence.count = res.count;
      repeatStart = res.start;
      take(start, res.end, "repeat");
      break;
    }
  }

  // 8. deadline
  scan(new RegExp(`(^|\\s)(?:due|by|before|deadline:?)\\s+(?:on\\s+)?(${DATE_ANY})(?:\\s+(?:at\\s+)?(${TIME_SRC}))?(?=\\s|$|[,.;:)])`, "gi"), (m) => {
    if (out.due) return false;
    const d = resolveDate(m[2], ctx);
    if (!d) return false;
    out.due = d;
    if (m[3]) out.dueTime = resolveTime(m[3]);
    return "due";
  });
  scan(new RegExp(`(^|\\s)(?:due|by)\\s+(${TIME_SRC})(?=\\s|$|[,.;:)])`, "gi"), (m) => {
    if (out.dueTime) return false;
    const tm = resolveTime(m[2]);
    if (!tm) return false;
    out.due = out.due ?? ctx.today;
    out.dueTime = tm;
    return "due";
  });

  // 9. planned date (+ time / part of day)
  const plannedRe = (src: string, prefix: string) =>
    new RegExp(`(^|\\s)${prefix}(${src})(?:\\s+(?:at\\s+)?(${TIME_SRC}|${PART_SRC}))?(?=\\s|$|[,.;:)])`, "gi");
  const onPlanned = (m: RegExpExecArray): SpanKind | false => {
    if (out.planned) return false;
    const d = resolveDate(m[2], ctx);
    if (!d) return false;
    out.planned = d;
    const extra = m[3]?.toLowerCase();
    if (extra) out.plannedTime = PART_TIME[extra] ?? resolveTime(extra);
    else if (m[2].toLowerCase() === "tonight") out.plannedTime = "20:00";
    return "planned";
  };
  scan(plannedRe(DATE_ANY, "(?:on|for|starting|from)\\s+"), onPlanned);
  // "sat 2pm": an ambiguous weekday is safe when a time follows it
  scan(new RegExp(`(^|\\s)(${WD_AMBIG})\\s+(?:at\\s+)?(${TIME_SRC})(?=\\s|$|[,.;:)])`, "gi"), onPlanned);
  scan(plannedRe(DATE_LOOSE, ""), onPlanned);

  // "this morning", "this evening"
  scan(new RegExp(`(^|\\s)this\\s+(${PART_SRC})\\b`, "gi"), (m) => {
    if (out.planned && out.planned !== ctx.today) return false;
    out.planned = ctx.today;
    out.plannedTime = out.plannedTime ?? PART_TIME[m[2].toLowerCase()];
    return "planned";
  });

  // 10. standalone time
  scan(new RegExp(`(^|\\s)(${TIME_SRC})(?=\\s|$|[,.;:)])`, "gi"), (m) => {
    if (out.plannedTime) return false;
    const tm = resolveTime(m[2]);
    if (!tm) return false;
    out.plannedTime = tm;
    return "planned";
  });

  if (rangeTime && !out.plannedTime) out.plannedTime = rangeTime;

  // A time without a date means today, or tomorrow if that time has already passed.
  if (out.plannedTime && !out.planned && !out.recurrence) {
    const [h, mi] = out.plannedTime.split(":").map(Number);
    const passed = ctx.nowMinutes != null && h * 60 + mi <= ctx.nowMinutes;
    out.planned = passed ? addDays(ctx.today, 1) : ctx.today;
  }

  // Recurrence anchor and start date.
  if (out.recurrence) {
    const r = out.recurrence;
    // The rule moves the deadline whenever there is one (see recurrence.ts).
    const anchorDue = repeatAnchorDue || !!out.due;
    if (anchorDue && out.due && out.planned && r.freq === "weekly" && r.byDay?.length) {
      // "on mon every mon due fri": the weekdays describe the plan; move them to the deadline
      const pw = WEEKDAY_CODES[weekday(out.planned)];
      const dw = WEEKDAY_CODES[weekday(out.due)];
      if (r.byDay.includes(pw) && !r.byDay.includes(dw)) {
        const shift = ((diffDays(out.due, out.planned) % 7) + 7) % 7;
        r.byDay = r.byDay.map((d) => WEEKDAY_CODES[(WEEKDAY_CODES.indexOf(d) + shift) % 7]);
      }
    }
    const explicit = repeatStart ?? (anchorDue ? out.due : out.planned);
    if (explicit) {
      r.start = explicit;
    } else {
      // first matching day from today; from tomorrow if today's time has already passed
      const time = anchorDue ? out.dueTime : out.plannedTime;
      const passed = time != null && ctx.nowMinutes != null &&
        Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) <= ctx.nowMinutes;
      const from = passed ? addDays(ctx.today, 1) : ctx.today;
      r.start = from;
      const norm = normalizeRule(r);
      r.start = firstOnOrAfter({ ...norm, count: null, until: null }, from) ?? from;
    }
    Object.assign(r, normalizeRule(r));
    if (anchorDue) {
      if (out.due && out.planned) {
        // keep the given planned offset relative to the (possibly moved) due date
        const off = diffDays(out.planned, out.due);
        out.due = r.start;
        out.planned = addDays(r.start, off);
      } else {
        out.due = r.start;
      }
    } else {
      out.planned = r.start;
    }
  }

  if (out.reminders.length && !out.planned && out.due) out.reminders.forEach((r) => (r.anchor = "due"));

  // Title: what is left, with quote marks removed and dangling connectors trimmed.
  let title = "";
  for (let i = 0; i < input.length; i++) if (!consumed[i]) title += input[i];
  title = title.replace(/"([^"]*)"/g, "$1");
  title = title.replace(/\s+/g, " ").trim();
  const CONNECT = /^(?:on|at|by|for|due|from|starting|and|with|,|-|–)\s+|\s+(?:on|at|by|for|due|from|starting|and|with|,|-|–)$/i;
  let prev = "";
  while (prev !== title) {
    prev = title;
    title = title.replace(CONNECT, "").replace(/[\s,;:–-]+$/, "").trim();
  }
  out.title = title;
  out.spans.sort((a, b) => a.start - b.start);
  return out;
}

// ---------- recurrence phrase ----------

interface Tok {
  w: string;
  s: number;
  e: number;
}
function tokensFrom(str: string, from: number): Tok[] {
  const toks: Tok[] = [];
  const re = /[a-z0-9]+(?:st|nd|rd|th)?|[,&/]/gi;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    // stop at characters that break the phrase (a protected quote or a new marker)
    const gap = str.slice(toks.length ? toks[toks.length - 1].e : from, m.index);
    if (/[^\s]/.test(gap.replace(/[,&/]/g, ""))) break;
    toks.push({ w: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
    if (toks.length > 40) break;
  }
  return toks;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5,
};
function ordinalOf(w: string): number | null {
  if (w in ORDINAL_WORDS) return ORDINAL_WORDS[w];
  const m = w.match(/^(\d{1,2})(st|nd|rd|th)$/);
  return m ? Number(m[1]) : null;
}

function parseRecurrenceTail(
  str: string, from: number, keyword: string, ctx: ParseContext,
): { rule: Recurrence; end: number; until?: ISODate; count?: number; start: ISODate | null } | null {
  const toks = tokensFrom(str, from);
  let i = 0;
  const peek = (k = 0) => toks[i + k]?.w;
  let end = from;
  const eat = () => {
    end = toks[i].e;
    return toks[i++].w;
  };
  const rule: Recurrence = { freq: "daily", interval: 1, mode: "schedule", start: ctx.today };

  const readWeekdays = (): Weekday[] => {
    const days: Weekday[] = [];
    while (i < toks.length) {
      const w = peek()!;
      if (WD_MAP[w]) {
        days.push(WD_MAP[w]);
        eat();
        continue;
      }
      if ((w === "," || w === "and" || w === "&" || w === "/") && WD_MAP[peek(1) ?? ""]) {
        eat();
        continue;
      }
      if (w === "weekday" || w === "weekdays") {
        days.push("MO", "TU", "WE", "TH", "FR");
        eat();
        continue;
      }
      break;
    }
    return [...new Set(days)];
  };

  /** "the 1st and 15th", "the last day", "the 2nd tue", "last fri" */
  const readMonthDays = (): boolean => {
    let any = false;
    while (i < toks.length) {
      if (peek() === "the") {
        eat();
        continue;
      }
      if ((peek() === "," || peek() === "and" || peek() === "&") && any) {
        eat();
        continue;
      }
      const o = ordinalOf(peek() ?? "");
      if (o == null) break;
      const save = i;
      const saveEnd = end;
      eat();
      const nx = peek();
      if (nx && WD_MAP[nx]) {
        eat();
        (rule.byNthDay ||= []).push({ day: WD_MAP[nx], n: o });
      } else if (nx === "day") {
        eat();
        (rule.byMonthDay ||= []).push(o);
      } else if (o > 0 && /\d/.test(toks[save].w)) {
        (rule.byMonthDay ||= []).push(o);
      } else {
        i = save;
        end = saveEnd;
        break;
      }
      any = true;
      if (peek() === "of" && (peek(1) === "the" || peek(1) === "every") && peek(2) === "month") {
        eat(); eat(); eat();
      } else if (peek() === "of" && peek(1) === "month") {
        eat(); eat();
      }
    }
    return any;
  };

  if (keyword !== "every") {
    rule.freq = keyword === "daily" ? "daily" : keyword === "weekly" ? "weekly" : keyword === "monthly" ? "monthly" : "yearly";
  } else {
    if (peek() === "other") {
      eat();
      rule.interval = 2;
    } else if (peek() && Number.isFinite(toNum(peek()!)) && /^(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(peek()!)) {
      const n = toNum(peek()!);
      const nx = peek(1);
      if (nx && /^(days?|weeks?|months?|years?)$/.test(nx)) {
        eat();
        rule.interval = n;
      }
    }
    const w = peek();
    if (!w) return null;
    if (/^days?$/.test(w)) {
      eat();
      rule.freq = "daily";
    } else if (w === "weekday" || w === "weekdays") {
      eat();
      rule.freq = "weekly";
      rule.byDay = ["MO", "TU", "WE", "TH", "FR"];
    } else if (w === "weekend" || w === "weekends") {
      eat();
      rule.freq = "weekly";
      rule.byDay = ["SA", "SU"];
    } else if (/^weeks?$/.test(w)) {
      eat();
      rule.freq = "weekly";
    } else if (/^months?$/.test(w)) {
      eat();
      rule.freq = "monthly";
    } else if (/^years?$/.test(w)) {
      eat();
      rule.freq = "yearly";
    } else if (WD_MAP[w]) {
      rule.freq = "weekly";
      rule.byDay = readWeekdays();
    } else if (MONTH_MAP[w] && ordinalOf(peek(1) ?? "") !== null || (MONTH_MAP[w] && /^\d{1,2}$/.test(peek(1) ?? ""))) {
      rule.freq = "yearly";
      rule.byMonth = [MONTH_MAP[eat()]];
      const d = parseInt(eat(), 10);
      rule.byMonthDay = [d];
    } else if (ordinalOf(w) !== null || w === "the") {
      rule.freq = "monthly";
      if (!readMonthDays()) return null;
    } else {
      return null;
    }
  }

  // "on mon, wed" / "on the 1st and 15th" / "on the last fri" / "in march"
  if (peek() === "on") {
    const save = i;
    const saveEnd = end;
    eat();
    if (rule.freq === "weekly" || rule.freq === "daily") {
      const days = readWeekdays();
      if (days.length) {
        if (rule.freq === "daily") rule.freq = "weekly";
        rule.byDay = days;
      } else {
        i = save;
        end = saveEnd;
      }
    } else if (rule.freq === "monthly") {
      if (!readMonthDays()) {
        i = save;
        end = saveEnd;
      }
    } else if (rule.freq === "yearly") {
      const mw = peek();
      if (mw && MONTH_MAP[mw] && /^\d{1,2}(st|nd|rd|th)?$/.test(peek(1) ?? "")) {
        rule.byMonth = [MONTH_MAP[eat()]];
        rule.byMonthDay = [parseInt(eat(), 10)];
      } else if (!readMonthDays()) {
        i = save;
        end = saveEnd;
      }
    }
  }

  // tails, any order
  let until: ISODate | undefined;
  let count: number | undefined;
  let start: ISODate | null = null;
  for (let guard = 0; guard < 4; guard++) {
    const w = peek();
    if (!w) break;
    if ((w === "after" || w === "from") && /^(done|completion|completed|complete|finishing|finished|i)$/.test(peek(1) ?? "")) {
      eat();
      if (eat() === "i") {
        // "after i finish"
        if (/^(finish|complete|do)/.test(peek() ?? "")) eat();
        else break;
      }
      rule.mode = "completion";
      continue;
    }
    if ((w === "until" || w === "till") && i + 1 < toks.length) {
      const res = dateAt(str, toks[i + 1].s, ctx);
      if (res) {
        eat();
        until = res.date;
        end = res.end;
        while (i < toks.length && toks[i].s < end) i++;
        continue;
      }
    }
    if ((w === "starting" || w === "beginning" || w === "from") && i + 1 < toks.length) {
      let k = i + 1;
      if (toks[k]?.w === "on") k++;
      const res = toks[k] ? dateAt(str, toks[k].s, ctx) : null;
      if (res) {
        start = res.date;
        end = res.end;
        while (i < toks.length && toks[i].s < end) i++;
        continue;
      }
    }
    if (/^\d+$/.test(w) && peek(1) === "times") {
      count = Number(eat());
      eat();
      continue;
    }
    break;
  }
  if (rule.mode === "completion") {
    delete rule.byDay;
    delete rule.byMonthDay;
    delete rule.byNthDay;
    delete rule.byMonth;
  }
  return { rule, end, until, count, start };
}

function dateAt(str: string, at: number, ctx: ParseContext): { date: ISODate; end: number } | null {
  const re = new RegExp(`(?:${DATE_ANY})`, "iy");
  re.lastIndex = at;
  const m = re.exec(str);
  if (!m) return null;
  const d = resolveDate(m[0], ctx);
  return d ? { date: d, end: at + m[0].length } : null;
}
