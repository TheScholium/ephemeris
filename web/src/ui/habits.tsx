// Habits: a Streaks-style grid of rings, kept apart from tasks.
// Press and hold a ring to check today off (or to undo); a short tap opens the habit.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  createHabit, defaultGlyph, describeHabit, describeSchedule, habitState, habitStats, historyGrid, holdCheckIn, isDone,
  longDate, MONTH_NAMES, parseISO, perDayOf, setCount, setDone, streak, type Habit, type HabitSchedule,
} from "@ephemeris/core";
import { Icon } from "./icons";
import { isWide, showToast, store, today, useAtom, useStore } from "../state";

const HOLD_MS = 600;
const R = 54;
const C = 2 * Math.PI * R;

function Ring({ h, td, holding }: { h: Habit; td: string; holding: boolean }) {
  const st = habitState(h, td, store.settings.weekStart);
  const s = h.schedule;
  // weekly/monthly habits: one segment per required day; others: one per check-in today
  const unitSegs = st.progress ? st.progress.target : st.today.target;
  const segs = unitSegs <= 24 ? unitSegs : 0;
  const gap = segs > 1 ? (segs > 12 ? 4 : 7) : 0;
  const seg = segs ? C / segs - gap : C;
  const done = st.progress
    ? Math.min(st.progress.done, st.progress.target)
    : st.today.target > 1 ? Math.min(st.today.count, st.today.target) : st.doneToday ? 1 : 0;
  const track = segs > 1 ? `${seg} ${gap}` : undefined;
  const prog = segs > 1
    ? Array.from({ length: done }, () => `${seg} ${gap}`).join(" ") + ` 0 ${C}`
    : segs === 0 && unitSegs > 1 ? `${(done / unitSegs) * C} ${C}` : `${done ? C : 0} ${C}`;
  const resting = !st.due && !st.doneToday;
  void s;
  return (
    <svg class={`hring ${st.doneToday ? "is-done" : ""} ${resting ? "is-rest" : ""}`} viewBox="0 0 120 120" aria-hidden="true">
      <circle class="h-fill" cx="60" cy="60" r={R - 6} />
      <circle class="h-track" cx="60" cy="60" r={R} stroke-dasharray={track} transform="rotate(-90 60 60)" />
      {done > 0 && <circle class="h-prog" cx="60" cy="60" r={R} stroke-dasharray={prog} transform="rotate(-90 60 60)" />}
      <circle class={`h-hold ${holding ? "on" : ""} ${st.doneToday ? "undo" : ""}`} cx="60" cy="60" r={R}
        stroke-dasharray={`${C} ${C}`} transform="rotate(-90 60 60)" />
      <text class="h-glyph" x="60" y="61" text-anchor="middle" dominant-baseline="central">{h.glyph || defaultGlyph(h.name)}</text>
    </svg>
  );
}

function Cell({ h, onOpen }: { h: Habit; onOpen: () => void }) {
  const td = today();
  const ws = store.settings.weekStart;
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef(0);
  const fired = useRef(false);
  const st = habitState(h, td, ws);
  const sk = streak(h, td, ws);

  const complete = () => {
    const k = perDayOf(h);
    const { before, after } = holdCheckIn(store, h.id, td);
    const undo = () => setCount(store, h.id, td, before);
    if (after > before) {
      navigator.vibrate?.(after >= k ? 18 : 10);
      showToast(after >= k ? `${h.name}: done` : `${h.name}: ${after} of ${k} today`, undo);
    } else {
      navigator.vibrate?.(8);
      showToast(`${h.name}: today reset`, undo);
    }
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    start.current = Date.now();
    fired.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      fired.current = true;
      setHolding(false);
      complete();
    }, HOLD_MS);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const up = () => {
    const quick = Date.now() - start.current < 250;
    cancel();
    if (!fired.current && quick) onOpen();
  };
  useEffect(() => cancel, []);

  return (
    <div class="hcell">
      <button
        class="hbtn"
        aria-label={`${h.name}. ${st.label}. Press and hold to ${st.doneToday ? "reset today" : st.today.target > 1 ? "add a check-in" : "mark done"}; tap for details.`}
        aria-pressed={st.doneToday}
        onPointerDown={down}
        onPointerUp={up}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onOpen();
            else complete();
          }
        }}
      >
        <Ring h={h} td={td} holding={holding} />
      </button>
      <div class="hname">{h.name}</div>
      <div class="hmeta">
        {sk.current > 0 && <span class="hstreak">{sk.current} {sk.unit}{sk.current === 1 ? "" : "s"}</span>}
        <span class={st.due ? "hdue" : ""}>{st.label}</span>
      </div>
    </div>
  );
}

export function HabitsView() {
  useStore();
  const wide = useAtom(isWide);
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const td = today();
  const all = store.habits;
  const active = all.filter((h) => !h.archived);
  const archived = all.filter((h) => h.archived);
  const dueCount = active.filter((h) => habitState(h, td, store.settings.weekStart).due).length;
  useEffect(() => {
    const onNew = () => setOpen("new");
    addEventListener("eph:new-habit", onNew);
    return () => removeEventListener("eph:new-habit", onNew);
  }, []);

  return (
    <div class="view habits">
      <header class="vh">
        <h1>Habits</h1>
        <div class="vh-sub">{longDate(td)}{active.length ? `, ${dueCount ? `${dueCount} still due` : "all done for now"}` : ""}</div>
      </header>

      {active.length === 0 && (
        <p class="empty">Add a habit with the + button, then press and hold its ring to check it off each day.</p>
      )}

      <div class="hgrid">
        {active.map((h) => <Cell key={h.id} h={h} onOpen={() => setOpen(h.id)} />)}
      </div>

      {active.length > 0 && <p class="hhint">Press and hold a ring to check it off. Tap it for history and settings.</p>}

      {archived.length > 0 && (
        <div class="more">
          <button class="link-btn" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide" : "Show"} archived habits ({archived.length})
          </button>
          {showArchived && (
            <ul class="harch">
              {archived.map((h) => (
                <li>
                  <span>{h.name}</span>
                  <button class="link-btn" onClick={() => store.update<Habit>(h.id, { archived: false })}>Restore</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {wide && (
        <button class="hfab" aria-label="New habit" title="New habit" onClick={() => setOpen("new")}>
          <Icon name="plus" size={20} />
        </button>
      )}

      {open && <HabitDetail id={open === "new" ? null : open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---------- detail / editor ----------

const TYPES: { v: HabitSchedule["type"]; label: string }[] = [
  { v: "daily", label: "Every day" },
  { v: "week", label: "Times per week" },
  { v: "month", label: "Times per month" },
  { v: "interval", label: "Every few days" },
  { v: "days", label: "Specific weekdays" },
];
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ScheduleEditor({ s, onChange }: { s: HabitSchedule; onChange: (s: HabitSchedule) => void }) {
  const ws = store.settings.weekStart;
  const order = Array.from({ length: 7 }, (_, i) => (i + ws) % 7);
  return (
    <div class="hsched">
      <select id="habit-schedule" value={s.type} aria-label="How often"
        onChange={(e) => {
          const type = e.currentTarget.value as HabitSchedule["type"];
          onChange(type === "week" ? { type, n: 3 } : type === "month" ? { type, n: 8 } : type === "interval" ? { type, n: 2 }
            : type === "days" ? { type, days: [1, 3, 5] } : { type });
        }}>
        {TYPES.map((t) => <option value={t.v}>{t.label}</option>)}
      </select>
      {(s.type === "week" || s.type === "month") && (
        <label class="inline">
          <input id="habit-n" class="num" type="number" min={1} max={s.type === "week" ? 7 : 31} value={s.n ?? 1}
            onChange={(e) => onChange({ ...s, n: Math.max(1, Math.min(s.type === "week" ? 7 : 31, Number(e.currentTarget.value) || 1)) })} />
          times a {s.type}
        </label>
      )}
      {s.type === "interval" && (
        <label class="inline">
          at least once every
          <input id="habit-n" class="num" type="number" min={2} max={30} value={s.n ?? 2}
            onChange={(e) => onChange({ ...s, n: Math.max(2, Math.min(30, Number(e.currentTarget.value) || 2)) })} />
          days
        </label>
      )}
      {s.type === "days" && (
        <div class="wdays" role="group" aria-label="Weekdays">
          {order.map((d) => {
            const on = (s.days ?? []).includes(d);
            return (
              <button class={`wd ${on ? "on" : ""}`} aria-pressed={on} aria-label={WD_LONG[d]}
                onClick={() => {
                  const next = on ? (s.days ?? []).filter((x) => x !== d) : [...(s.days ?? []), d];
                  if (next.length) onChange({ ...s, days: next });
                }}>{WD[d]}</button>
            );
          })}
        </div>
      )}
      <p class="dim small">{describeSchedule(s)}. {explain(s)}</p>
    </div>
  );
}

function explain(s: HabitSchedule): string {
  switch (s.type) {
    case "daily": return "Each missed day ends the streak.";
    case "days": return "Other days are rest days and do not count.";
    case "week": return "The streak counts weeks in which you reached the number. Any days work.";
    case "month": return "The streak counts months in which you reached the number.";
    case "interval": return "The streak continues while no gap is longer than this.";
  }
}

function HabitDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  useStore();
  const wide = useAtom(isWide);
  const h = id ? store.get<Habit>(id) : null;
  const [draft, setDraft] = useState<{ name: string; glyph: string; schedule: HabitSchedule; perDay: number }>({ name: "", glyph: "", schedule: { type: "daily" }, perDay: 1 });
  const nameRef = useRef<HTMLInputElement>(null);
  const td = today();
  const ws = store.settings.weekStart;
  useEffect(() => {
    if (!id) nameRef.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (id && (!h || h.deleted)) return null;

  const name = h ? h.name : draft.name;
  const glyph = h ? h.glyph : draft.glyph;
  const schedule = h ? h.schedule : draft.schedule;
  const perDay = h ? perDayOf(h) : draft.perDay;
  const set = (patch: Partial<{ name: string; glyph: string; schedule: HabitSchedule; perDay: number }>) => {
    if (h) store.update<Habit>(h.id, patch as Partial<Habit>);
    else setDraft({ ...draft, ...patch });
  };

  return (
    <div class="sheet-bg" onClick={onClose}>
      <div class={`sheet hsheet ${wide ? "dialog" : ""}`} role="dialog" aria-label={h ? h.name : "New habit"} onClick={(e) => e.stopPropagation()}>
        <div class="dt-top">
          <span class="dim small">{h ? describeHabit(h) : "New habit"}</span>
          <button class="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>

        <div class="hhead">
          <input id="habit-glyph" class="hglyph-in" value={glyph} maxLength={2} aria-label="Letter in the ring"
            placeholder={defaultGlyph(name || "H")}
            onInput={(e) => set({ glyph: e.currentTarget.value.slice(0, 2) })} />
          <input id="habit-name" ref={nameRef} class="hname-in" value={name} placeholder="Read 20 pages" aria-label="Habit name"
            onInput={(e) => {
              const v = e.currentTarget.value;
              if (h) set({ name: v || h.name });
              else setDraft({ ...draft, name: v });
            }} />
        </div>

        <div class="dt-field">
          <div class="dt-label"><Icon name="repeat" /> How often</div>
          <ScheduleEditor s={schedule} onChange={(schedule) => set({ schedule })} />
          <label class="inline hperday">
            <input id="habit-perday" class="num" type="number" min={1} max={50} value={perDay}
              onChange={(e) => set({ perDay: Math.max(1, Math.min(50, Math.floor(Number(e.currentTarget.value) || 1))) })} />
            {perDay === 1 ? "time a day" : "times a day"}
          </label>
          {perDay > 1 && <p class="dim small">A day counts for the streak when you reach {perDay}. Each press and hold adds one.</p>}
        </div>
        {h && perDay > 1 && <TodayCount h={h} td={td} />}

        {h ? <HabitHistory h={h} td={td} ws={ws} /> : (
          <div class="dt-actions">
            <button class="btn primary" disabled={!draft.name.trim()} onClick={() => {
              createHabit(store, draft.name, draft.schedule, draft.glyph || undefined, draft.perDay);
              showToast(`Added ${draft.name.trim()}`);
              onClose();
            }}>Add habit</button>
            <button class="btn" onClick={onClose}>Cancel</button>
          </div>
        )}

        {h && (
          <footer class="dt-foot">
            <div class="dt-actions">
              <button class="btn" onClick={() => {
                store.update<Habit>(h.id, { archived: true });
                showToast(`Archived ${h.name}`, () => store.update<Habit>(h.id, { archived: false }));
                onClose();
              }}>Archive</button>
              <button class="btn danger" onClick={() => {
                store.update<Habit>(h.id, { deleted: true });
                showToast(`Deleted ${h.name}`, () => store.update<Habit>(h.id, { deleted: false }));
                onClose();
              }}><Icon name="trash" /> Delete</button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function HabitHistory({ h, td, ws }: { h: Habit; td: string; ws: number }) {
  const wide = useAtom(isWide);
  const weeks = wide ? 26 : 16;
  const sk = streak(h, td, ws);
  const stats = habitStats(h, td, ws);
  const grid = historyGrid(h, td, weeks, ws);
  const unit = (n: number) => `${sk.unit}${n === 1 ? "" : "s"}`;
  const rows = Array.from({ length: 7 }, (_, i) => (i + ws) % 7);
  return (
    <>
      <div class="hstats">
        <div><b>{sk.current}</b><span>current streak, {unit(sk.current)}</span></div>
        <div><b>{sk.best}</b><span>best streak</span></div>
        <div><b>{Math.round(stats.rate30 * 100)}%</b><span>last 30 days</span></div>
        <div><b>{stats.total}</b><span>days done</span></div>
      </div>
      <div class="dt-field">
        <div class="dt-label"><Icon name="calendar" /> History <span class="dim small">tap a day to change it</span></div>
        <div class="hhist-wrap">
          <div class="hhist" style={{ gridTemplateColumns: `20px repeat(${weeks}, 16px)` }}>
            <span />
            {grid.map((col, i) => {
              // label the column that holds the 1st of a month; the first column only if
              // its month still has two weeks left (so labels never collide)
              const firstOfMonth = col.find((c) => parseISO(c.date).d === 1);
              const lead = i === 0 && parseISO(col[0].date).d <= 14 ? col[0] : null;
              const at = firstOfMonth ?? lead;
              return <span class="hmon">{at ? MONTH_NAMES[parseISO(at.date).m - 1] : ""}</span>;
            })}
            {rows.map((wd, r) => (
              <>
                <span class="hwd">{r % 2 === 0 ? WD[wd] : ""}</span>
                {grid.map((col) => {
                  const c = col[r];
                  if (c.future) return <span class="hday future" />;
                  return (
                    <button
                      class={`hday ${c.done ? "done" : c.partial ? "partial" : ""} ${c.scheduled ? "" : "rest"} ${c.date === td ? "today" : ""}`}
                      aria-label={`${longDate(c.date)}: ${c.done ? "done" : c.partial ? "partly done" : "not done"}`}
                      aria-pressed={c.done}
                      onClick={() => setDone(store, h.id, c.date, !isDone(h, c.date))}
                    />
                  );
                })}
              </>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function TodayCount({ h, td }: { h: Habit; td: string }) {
  const st = habitState(h, td, store.settings.weekStart);
  const { count, target } = st.today;
  return (
    <div class="dt-field htoday">
      <div class="dt-label"><Icon name="habit" /> Today</div>
      <div class="row-ctl">
        <button class="icon-btn hstep" aria-label="Remove one check-in" disabled={count === 0}
          onClick={() => setCount(store, h.id, td, count - 1)}>−</button>
        <span class="hcount"><b>{count}</b> of {target}</span>
        <button class="icon-btn hstep" aria-label="Add one check-in"
          onClick={() => setCount(store, h.id, td, count + 1)}>+</button>
      </div>
    </div>
  );
}
