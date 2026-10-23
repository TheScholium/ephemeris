// Week / three-day calendar: planned tasks as time blocks (height = estimate), deadlines
// as flags in the all-day lane, and your own calendars beside them for planning.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addDays, createTask, epochToZoned, repeatGhosts, fmtDuration, fmtHM, fmtTime12, isOpen, MONTH_NAMES, parseHM, parseICS, parseISO,
  startOfWeek, todayView, updateTask, weekday, WEEKDAY_NAMES, type CalEvent, type ISODate, type Task,
} from "@ephemeris/core";
import { Icon } from "./icons";
import { Section } from "./common";
import { api, clock, connected, isWide, openTask, showToast, store, today, useAtom, useStore } from "../state";

const HOUR = 48; // px per hour

type Span = 1 | 3 | 7;
const SPANS: [Span, string][] = [[1, "Day"], [3, "3 days"], [7, "Week"]];
const SPAN_KEY = "eph.calDays";
function storedSpan(): Span | null {
  try {
    const v = Number(localStorage.getItem(SPAN_KEY));
    return v === 1 || v === 3 || v === 7 ? v : null;
  } catch {
    return null;
  }
}
const SNAP = 15;

const feedCache = new Map<string, { at: number; text: string }>();

function useFeeds(from: ISODate, to: ISODate): CalEvent[] {
  const feeds = store.settings.feeds ?? [];
  const [texts, setTexts] = useState<Record<number, string>>({});
  const key = feeds.map((f) => f.url).join("|");
  useEffect(() => {
    if (!connected() || !feeds.length) return;
    let alive = true;
    feeds.forEach(async (f, i) => {
      const c = feedCache.get(f.url);
      if (c && Date.now() - c.at < 10 * 60_000) {
        setTexts((t) => ({ ...t, [i]: c.text }));
        return;
      }
      try {
        const r = await api(`/api/feed/${i}`);
        if (!r.ok) throw new Error(String(r.status));
        const text = await r.text();
        feedCache.set(f.url, { at: Date.now(), text });
        if (alive) setTexts((t) => ({ ...t, [i]: text }));
      } catch (e) {
        console.warn("feed", f.name, e);
      }
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return useMemo(() => {
    const out: CalEvent[] = [];
    const tz = store.settings.tz;
    feeds.forEach((f, i) => {
      if (!texts[i]) return;
      try {
        for (const e of parseICS(texts[i], from, to, tz)) out.push({ ...e, calendar: f.name, color: f.color });
      } catch (e) {
        console.warn("parse", f.name, e);
      }
    });
    return out;
  }, [texts, from, to]);
}

interface Item {
  kind: "task" | "event";
  id: string;
  title: string;
  start: number; // minutes
  dur: number;
  task?: Task;
  ev?: CalEvent;
  ghost?: boolean;
  lane?: number;
  lanes?: number;
}

function layout(items: Item[]): Item[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.dur - a.dur);
  let cluster: Item[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes: number[] = [];
    for (const it of cluster) {
      let l = lanes.findIndex((end) => end <= it.start);
      if (l < 0) {
        l = lanes.length;
        lanes.push(0);
      }
      lanes[l] = it.start + Math.max(it.dur, 20);
      it.lane = l;
    }
    cluster.forEach((it) => (it.lanes = lanes.length));
    cluster = [];
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.start + Math.max(it.dur, 20));
  }
  flush();
  return sorted;
}

type Drag = {
  id: string;
  mode: "move" | "resize" | "place";
  x0: number;
  y0: number;
  x: number;
  y: number;
  origDay: number; // column index (-1 for tray)
  origMin: number;
  origDur: number;
  moved: boolean;
};

export function CalendarView() {
  useStore();
  useAtom(clock);
  const wide = useAtom(isWide);
  const td = today();
  const s = store.settings;
  // 1, 3 or 7 days; each device remembers its own choice, else phone = 1 and computer = 7
  const [nDays, setNDays] = useState<Span>(() => storedSpan() ?? (wide ? 7 : 1));
  const startFor = (n: Span, d: ISODate) => (n === 7 ? startOfWeek(d, s.weekStart) : d);
  const [anchor, setAnchor] = useState<ISODate>(() => startFor(nDays, td));
  useEffect(() => {
    if (storedSpan() != null) return;
    const n: Span = wide ? 7 : 1;
    setNDays(n);
    setAnchor(startFor(n, td));
  }, [wide]);
  const chooseSpan = (n: Span) => {
    // keep today in view when it is visible now; otherwise keep the shown period
    const showingToday = td >= anchor && td <= addDays(anchor, nDays - 1);
    setNDays(n);
    setAnchor(startFor(n, showingToday ? td : anchor));
    try {
      localStorage.setItem(SPAN_KEY, String(n));
    } catch {
      /* private mode */
    }
  };
  const days = Array.from({ length: nDays }, (_, i) => addDays(anchor, i));
  const from = days[0];
  const to = days[nDays - 1];
  const events = useFeeds(from, to);
  const dayStart = Math.floor(parseHM(s.dayStart) / 60) * 60;
  const dayEnd = Math.ceil(parseHM(s.dayEnd) / 60) * 60;
  const span = Math.max(60, dayEnd - dayStart);
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    // scroll near the current time on first show
    const now = parseHM(epochToZoned(Date.now(), s.tz).time);
    scroller.current?.scrollTo({ top: Math.max(0, ((now - dayStart) / 60) * HOUR - 120) });
  }, []);

  const tasks = store.tasks.filter((t) => isOpen(t));
  const timed = new Map<ISODate, Item[]>();
  const allDay = new Map<ISODate, { kind: "plan" | "due" | "event"; task?: Task; ev?: CalEvent; ghost?: boolean }[]>();
  days.forEach((d) => {
    timed.set(d, []);
    allDay.set(d, []);
  });
  for (const t of tasks) {
    if (t.planned && timed.has(t.planned)) {
      if (t.plannedTime) timed.get(t.planned)!.push({ kind: "task", id: t.id, title: t.title, start: parseHM(t.plannedTime), dur: t.estimate || 30, task: t });
      else allDay.get(t.planned)!.push({ kind: "plan", task: t });
    }
    if (t.due && allDay.has(t.due) && t.due !== t.planned) allDay.get(t.due)!.push({ kind: "due", task: t });
  }
  for (const g of repeatGhosts(store.tasks, from, to)) {
    const t = g.task;
    if (g.kind === "due") allDay.get(g.date)?.push({ kind: "due", task: t, ghost: true });
    else if (t.plannedTime) timed.get(g.date)?.push({ kind: "task", id: t.id + g.date, title: t.title, start: parseHM(t.plannedTime), dur: t.estimate || 30, task: t, ghost: true });
    else allDay.get(g.date)?.push({ kind: "plan", task: t, ghost: true });
  }
  for (const e of events) {
    if (e.allDay) {
      let d = e.date;
      while (d <= e.endDate) {
        allDay.get(d)?.push({ kind: "event", ev: e });
        d = addDays(d, 1);
      }
    } else if (timed.has(e.date)) {
      timed.get(e.date)!.push({ kind: "event", id: e.uid, title: e.title, start: parseHM(e.start!), dur: Math.max(15, e.duration), ev: e });
    }
  }

  // tray: tasks to place
  const v = todayView(store.tasks, td);
  const trayIds = new Set<string>();
  const tray: Task[] = [];
  const pushTray = (t: Task) => {
    if (!trayIds.has(t.id)) {
      trayIds.add(t.id);
      tray.push(t);
    }
  };
  days.forEach((d) => allDay.get(d)!.forEach((x) => x.kind === "plan" && x.task && !x.ghost && pushTray(x.task)));
  [...v.overdue, ...v.dueToday, ...v.carried, ...v.needsPlan].filter((t) => !t.plannedTime || !t.planned || t.planned < td).forEach(pushTray);

  // ----- pointer handling -----
  const colAt = (clientX: number): number => {
    const g = grid.current;
    if (!g) return -1;
    const r = g.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right) return -1;
    return Math.min(nDays - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * nDays)));
  };
  const minAt = (clientY: number): number => {
    const g = grid.current!;
    const r = g.getBoundingClientRect();
    const m = dayStart + ((clientY - r.top) / HOUR) * 60;
    return Math.round(m / SNAP) * SNAP;
  };

  const startDrag = (e: PointerEvent, it: Partial<Drag> & { id: string; mode: Drag["mode"] }) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const d: Drag = { origDay: -1, origMin: 0, origDur: 30, ...it, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    setDrag(d);
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const moved = cur.moved || Math.abs(ev.clientX - cur.x0) + Math.abs(ev.clientY - cur.y0) > 4;
      setDrag({ ...cur, x: ev.clientX, y: ev.clientY, moved });
      // keep the dragged block visible near the edges
      const sc = scroller.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (ev.clientY > r.bottom - 30) sc.scrollTop += 12;
        else if (ev.clientY < r.top + 30) sc.scrollTop -= 12;
      }
    };
    const up = (ev: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      const cur = dragRef.current;
      setDrag(null);
      if (!cur) return;
      if (!cur.moved) {
        openTask.set(cur.id);
        return;
      }
      const t = store.get<Task>(cur.id);
      if (!t) return;
      if (cur.mode === "resize") {
        const dur = Math.max(SNAP, cur.origDur + Math.round((ev.clientY - cur.y0) / HOUR * 60 / SNAP) * SNAP);
        updateTask(store, t.id, { estimate: dur });
        return;
      }
      const col = colAt(ev.clientX);
      if (col < 0) return;
      let min: number;
      if (cur.mode === "place") min = minAt(ev.clientY);
      else min = cur.origMin + Math.round(((ev.clientY - cur.y0) / HOUR) * 60 / SNAP) * SNAP;
      min = Math.max(0, Math.min(24 * 60 - SNAP, min));
      updateTask(store, t.id, { planned: days[col], plannedTime: fmtHM(min) });
      showToast(`${t.title}: ${WEEKDAY_NAMES[weekday(days[col])]} ${fmtTime12(fmtHM(min))}`);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  const nowLocal = epochToZoned(Date.now(), s.tz);
  const nowMin = parseHM(nowLocal.time);
  const title = (() => {
    const a = parseISO(from);
    const b = parseISO(to);
    if (nDays === 1) return `${WEEKDAY_NAMES[weekday(from)]}, ${MONTH_NAMES[a.m - 1]} ${a.d}`;
    return a.m === b.m ? `${MONTH_NAMES[a.m - 1]} ${a.d} to ${b.d}` : `${MONTH_NAMES[a.m - 1]} ${a.d} to ${MONTH_NAMES[b.m - 1]} ${b.d}`;
  })();

  const ghost = drag && drag.moved ? (() => {
    const t = store.get<Task>(drag.id);
    if (!t) return null;
    if (drag.mode === "place") {
      return <div class="cal-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>{t.title}</div>;
    }
    return null;
  })() : null;

  return (
    <div class="view cal-view">
      <header class="vh cal-head">
        <h1>{title}</h1>
        <div class="row-ctl">
          <div class="seg" role="group" aria-label="Days shown">
            {SPANS.map(([n, label]) => (
              <button class={nDays === n ? "on" : ""} aria-pressed={nDays === n} onClick={() => chooseSpan(n)}>{label}</button>
            ))}
          </div>
          <button class="icon-btn" aria-label={nDays === 1 ? "Previous day" : "Earlier"} onClick={() => setAnchor(addDays(anchor, -nDays))}><Icon name="left" /></button>
          <button class="btn" onClick={() => setAnchor(startFor(nDays, td))}>Today</button>
          <button class="icon-btn" aria-label={nDays === 1 ? "Next day" : "Later"} onClick={() => setAnchor(addDays(anchor, nDays))}><Icon name="right" /></button>
          {!s.feeds?.length && <a class="link-btn small" href="#/settings">Show your calendars here</a>}
        </div>
      </header>

      <div class="cal" style={{ "--n": nDays } as any}>
        <div class="cal-days">
          <div class="cal-corner" />
          {days.map((d) => {
            const load = timed.get(d)!.filter((i) => i.kind === "task").reduce((a, i) => a + i.dur, 0)
              + allDay.get(d)!.filter((x) => x.kind === "plan").reduce((a, x) => a + (x.task?.estimate ?? 0), 0);
            return (
              <div class={`cal-dayhead ${d === td ? "is-today" : ""}`}>
                <span class="cd-name">{WEEKDAY_NAMES[weekday(d)]}</span>
                <span class="cd-num">{parseISO(d).d}</span>
                {load > 0 && <span class="cd-load">{fmtDuration(load)}</span>}
              </div>
            );
          })}
        </div>
        <div class="cal-allday">
          <div class="cal-corner small dim">all day</div>
          {days.map((d) => (
            <div class="cal-adcol">
              {allDay.get(d)!.map((x) =>
                x.kind === "event" ? (
                  <div class="ad ev" style={{ "--c": x.ev!.color } as any} title={x.ev!.calendar}>{x.ev!.title}</div>
                ) : (
                  <div class={`ad ${x.kind} ${x.ghost ? "ghost" : ""}`} onPointerDown={(e) => x.ghost ? openTask.set(x.task!.id) : startDrag(e as PointerEvent, { id: x.task!.id, mode: "place" })}>
                    {x.kind === "due" ? <Icon name="due" size={11} /> : <Icon name="plan" size={11} />}
                    <span>{x.task!.title}</span>
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
        <div class="cal-scroll" ref={scroller}>
          <div class="cal-body" style={{ height: (span / 60) * HOUR }}>
            <div class="cal-hours">
              {Array.from({ length: span / 60 }, (_, i) => (
                <div class="cal-hour" style={{ top: i * HOUR }}>{fmtTime12(fmtHM(dayStart + i * 60)).replace(":00", "")}</div>
              ))}
            </div>
            <div class="cal-grid" ref={grid}>
              {days.map((d, col) => (
                <div class={`cal-col ${d === td ? "is-today" : ""}`} onDblClick={(e) => {
                  const min = minAt((e as MouseEvent).clientY);
                  const t = prompt(`New task on ${WEEKDAY_NAMES[weekday(d)]} at ${fmtTime12(fmtHM(min))}`);
                  if (t?.trim()) createTask(store, { title: t.trim(), planned: d, plannedTime: fmtHM(min), estimate: 30 });
                }}>
                  {Array.from({ length: span / 60 }, (_, i) => <i class="hl" style={{ top: i * HOUR }} />)}
                  {d === nowLocal.date && nowMin >= dayStart && nowMin <= dayEnd && <div class="nowline" style={{ top: ((nowMin - dayStart) / 60) * HOUR }} />}
                  {layout(timed.get(d)!).map((it) => {
                    let top = ((it.start - dayStart) / 60) * HOUR;
                    let h = Math.max(18, (it.dur / 60) * HOUR - 2);
                    let dx = 0;
                    const isDrag = drag && drag.moved && drag.id === it.id && it.kind === "task";
                    if (isDrag && drag!.mode === "move") {
                      const dmin = Math.round(((drag!.y - drag!.y0) / HOUR) * 60 / SNAP) * SNAP;
                      top += (dmin / 60) * HOUR;
                      const c = colAt(drag!.x);
                      if (c >= 0) dx = (c - col) * 100;
                    }
                    if (isDrag && drag!.mode === "resize") {
                      const dmin = Math.round(((drag!.y - drag!.y0) / HOUR) * 60 / SNAP) * SNAP;
                      h = Math.max(18, ((it.dur + dmin) / 60) * HOUR - 2);
                    }
                    const w = 100 / (it.lanes ?? 1);
                    const style = {
                      top, height: h,
                      left: `calc(${(it.lane ?? 0) * w}% + 2px)`,
                      width: `calc(${w}% - 4px)`,
                      transform: dx ? `translateX(${dx}%)` : undefined,
                      "--c": it.ev?.color,
                    } as any;
                    if (it.kind === "event") {
                      return (
                        <div class="blk ev" style={style} title={`${it.ev!.calendar}: ${it.title}`}>
                          <span class="blk-t">{it.title}</span>
                          {h > 30 && <span class="blk-m">{fmtTime12(fmtHM(it.start))}</span>}
                        </div>
                      );
                    }
                    const t = it.task!;
                    if (it.ghost) {
                      return (
                        <div class="blk task ghost" style={style} title="A later occurrence of a repeating task" onClick={() => openTask.set(t.id)}>
                          <span class="blk-t">{t.title}</span>
                          {h > 30 && <span class="blk-m">{fmtTime12(fmtHM(it.start))}, repeats</span>}
                        </div>
                      );
                    }
                    return (
                      <div class={`blk task ${isDrag ? "dragging" : ""} ${t.due && t.due < td ? "late" : ""}`} style={style}
                        onPointerDown={(e) => startDrag(e as PointerEvent, { id: t.id, mode: "move", origDay: col, origMin: it.start, origDur: it.dur })}>
                        <span class="blk-t">{t.title}</span>
                        {h > 30 && <span class="blk-m">{fmtTime12(fmtHM(it.start))}{t.estimate ? "" : ", no estimate"}{t.due ? `, due ${t.due === d ? "this day" : WEEKDAY_NAMES[weekday(t.due)]}` : ""}</span>}
                        <span class="blk-resize" aria-label="Change estimate"
                          onPointerDown={(e) => startDrag(e as PointerEvent, { id: t.id, mode: "resize", origDay: col, origMin: it.start, origDur: it.dur })} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Section title="To place" count={tray.length} note="Drag onto the calendar to give it a time">
        {tray.length ? (
          <div class="tray">
            {tray.map((t) => (
              <div class="tray-item" onPointerDown={(e) => startDrag(e as PointerEvent, { id: t.id, mode: "place" })}>
                <span>{t.title}</span>
                <span class="dim small">{t.estimate ? fmtDuration(t.estimate) : ""}{t.due ? ` due ${WEEKDAY_NAMES[weekday(t.due)]}` : ""}</span>
              </div>
            ))}
          </div>
        ) : <p class="empty">Nothing waiting for a time.</p>}
      </Section>
      {ghost}
    </div>
  );
}
