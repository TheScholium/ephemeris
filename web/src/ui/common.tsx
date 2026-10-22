import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import {
  completeTask, describeRule, diffDays, fmtDuration, fmtTime12, isOpen, relDate, reopenTask, subtasksOf,
  tagCounts, deleteTask, restoreTask, type ISODate, type Project, type Task,
} from "@ephemeris/core";
import { Icon } from "./icons";
import { openTask, selectMode, selection, showToast, store, today, toggleSelect, useAtom } from "../state";

// ---------- task row ----------

export interface RowOpts {
  /** the day this list represents; the planned badge is hidden when it equals it */
  day?: ISODate;
  /** row is a deadline marker in a day list (task planned elsewhere) */
  marker?: boolean;
  hideProject?: boolean;
  /** extra hover actions */
  actions?: (t: Task) => ComponentChildren;
  /** ids of the list, for shift-click range selection */
  listIds?: string[];
  showParent?: boolean;
  /** a projected future occurrence of a recurring task (not a real instance) */
  ghost?: boolean;
}

let lastClicked: string | null = null;

export function dueLabel(t: Task, td: ISODate): { text: string; cls: string } | null {
  if (!t.due) return null;
  const n = diffDays(t.due, td);
  const time = t.dueTime ? ` ${fmtTime12(t.dueTime)}` : "";
  if (n < 0) return { text: n === -1 ? "due yesterday" : `${-n} days late`, cls: "late" };
  if (n === 0) return { text: `due today${time}`, cls: "now" };
  if (n === 1) return { text: `due tomorrow${time}`, cls: "soon" };
  return { text: `due ${relDate(t.due, td)}${n < 7 ? time : ""}`, cls: n <= 3 ? "soon" : "" };
}

export function planLabel(t: Task, td: ISODate): string | null {
  if (!t.planned) return null;
  return `${relDate(t.planned, td)}${t.plannedTime ? " " + fmtTime12(t.plannedTime) : ""}`;
}

export function completeWithUndo(t: Task) {
  const next = completeTask(store, t.id, today());
  showToast(next ? `Done. Next: ${relDate((next.due ?? next.planned)!, today())}` : "Done", () => {
    store.batch(() => {
      reopenTask(store, t.id);
      for (const s of subtasksOf(store, t.id)) reopenTask(store, s.id);
      if (next) deleteTask(store, next.id);
    });
  });
}

export function deleteWithUndo(ids: string[]) {
  store.batch(() => ids.forEach((id) => deleteTask(store, id)));
  showToast(ids.length === 1 ? "Deleted" : `Deleted ${ids.length} tasks`, () =>
    store.batch(() => ids.forEach((id) => {
      restoreTask(store, id);
      // subtasks were deleted with the parent
      for (const r of store.dump()) if (r.kind === "task" && r.parentId === id && r.deleted) restoreTask(store, r.id);
    })),
  );
}

export function Check({ task, onDone }: { task: Task; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = task.status !== "open";
  return (
    <button
      class={`check ${done ? "is-done" : ""} ${busy ? "is-busy" : ""} ${task.due && task.due < today() && !done ? "is-late" : ""}`}
      aria-label={done ? "Mark as not done" : "Mark as done"}
      onClick={(e) => {
        e.stopPropagation();
        if (done) {
          reopenTask(store, task.id);
          return;
        }
        setBusy(true);
        setTimeout(() => {
          completeWithUndo(task);
          onDone?.();
        }, 280);
      }}
    >
      <Icon name="check" size={12} />
    </button>
  );
}

export function TaskRow({ task: t, opts = {} }: { task: Task; opts?: RowOpts }) {
  const sel = useAtom(selection);
  const mode = useAtom(selectMode);
  const open = useAtom(openTask);
  const td = today();
  const subs = subtasksOf(store, t.id);
  const subsDone = subs.filter((s) => s.status !== "open").length;
  const project = t.projectId ? store.get<Project>(t.projectId) : null;
  const parent = opts.showParent !== false && t.parentId ? store.get<Task>(t.parentId) : null;
  const due = opts.ghost ? null : dueLabel(t, td);
  const showPlan = !opts.ghost && t.planned && t.planned !== opts.day;
  const plan = showPlan ? planLabel(t, td) : null;
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSel = sel.has(t.id);

  const click = (e: MouseEvent) => {
    if (e.shiftKey && lastClicked && opts.listIds) {
      const a = opts.listIds.indexOf(lastClicked);
      const b = opts.listIds.indexOf(t.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        opts.listIds.slice(lo, hi + 1).forEach((id) => toggleSelect(id, true));
        return;
      }
    }
    lastClicked = t.id;
    if (mode || e.metaKey || e.ctrlKey || (sel.size && e.shiftKey)) {
      toggleSelect(t.id);
      return;
    }
    if (sel.size) selection.set(new Set());
    openTask.set(t.id);
  };

  return (
    <div
      class={`row ${t.status !== "open" ? "is-done" : ""} ${isSel && !opts.ghost ? "is-sel" : ""} ${open === t.id ? "is-open" : ""} ${opts.marker ? "is-marker" : ""} ${opts.ghost ? "is-ghost" : ""}`}
      onClick={opts.ghost ? () => openTask.set(t.id) : click}
      onTouchStart={() => {
        press.current = setTimeout(() => {
          selectMode.set(true);
          toggleSelect(t.id, true);
          navigator.vibrate?.(10);
        }, 480);
      }}
      onTouchEnd={() => press.current && clearTimeout(press.current)}
      onTouchMove={() => press.current && clearTimeout(press.current)}
      data-id={opts.ghost ? undefined : t.id}
      role="listitem"
    >
      <div class="row-gutter" aria-hidden={!t.plannedTime && !t.estimate}>
        {opts.marker ? <Icon name="due" class="ink-due" /> :
          t.plannedTime && (t.planned === opts.day || !opts.day) ? <span class="g-time">{fmtTime12(t.plannedTime)}</span> :
          t.estimate ? <span class="g-est">{fmtDuration(t.estimate)}</span> : null}
        {t.plannedTime && t.estimate && (t.planned === opts.day || !opts.day) && !opts.marker ? <span class="g-est">{fmtDuration(t.estimate)}</span> : null}
      </div>
      {opts.ghost ? (
        <span class="ghostmark" title="A later occurrence of a repeating task"><Icon name="repeat" size={12} /></span>
      ) : mode ? (
        <span class={`selbox ${isSel ? "on" : ""}`} aria-hidden="true"><Icon name="check" size={12} /></span>
      ) : (
        <Check task={t} />
      )}
      <div class="row-main">
        <div class="row-title">
          {t.starred && <Icon name="star" size={13} class="ink-brass star" title="Starred" />}
          <span>{t.title || <em class="dim">Untitled</em>}</span>
        </div>
        <div class="row-meta">
          {!showPlan && (t.plannedTime || t.estimate) && !opts.marker && (
            <span class="m-time">{t.plannedTime ? fmtTime12(t.plannedTime) : ""}{t.plannedTime && t.estimate ? ", " : ""}{t.estimate ? fmtDuration(t.estimate) : ""}</span>
          )}
          {parent && <span class="m-parent"><Icon name="sub" size={12} />{parent.title}</span>}
          {plan && <span class="m-plan"><Icon name="plan" size={12} />{plan}</span>}
          {t.recurrence && <span class="m-rep" title={describeRule(t.recurrence)}><Icon name="repeat" size={12} /></span>}
          {subs.length > 0 && <span class="m-sub">{subsDone}/{subs.length}</span>}
          {project && !opts.hideProject && <span class="m-proj"><i style={{ background: project.color }} />{project.name}</span>}
          {t.tags.map((g) => <span class="m-tag" key={g}>#{g}</span>)}
          {t.links.length > 0 && <Icon name="link" size={12} class="dim" />}
          {t.attachments.length > 0 && <Icon name="clip" size={12} class="dim" />}
          {t.location && <Icon name="pin" size={12} class="dim" />}
          {t.notes && <Icon name="log" size={12} class="dim" />}
        </div>
      </div>
      <div class="row-end">
        {due && <span class={`m-due ${due.cls}`}><Icon name="due" size={12} />{due.text}</span>}
        {opts.actions && <span class="row-actions" onClick={(e) => e.stopPropagation()}>{opts.actions(t)}</span>}
      </div>
    </div>
  );
}

export function TaskList({ tasks, opts = {}, empty }: { tasks: Task[]; opts?: RowOpts; empty?: ComponentChildren }) {
  const ids = tasks.map((t) => t.id);
  if (!tasks.length) return empty ? <div class="empty">{empty}</div> : null;
  return (
    <div class="list" role="list">
      {tasks.map((t) => <TaskRow key={t.id} task={t} opts={{ ...opts, listIds: ids }} />)}
    </div>
  );
}

export function Section({ title, note, children, cls, collapsed: initial, count, right }: {
  title: string; note?: ComponentChildren; children: ComponentChildren; cls?: string; collapsed?: boolean; count?: number; right?: ComponentChildren;
}) {
  const [collapsed, setCollapsed] = useState(!!initial);
  return (
    <section class={`sec ${cls ?? ""}`}>
      <header class="sec-head">
        <button class="sec-title" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          <span class={`caret ${collapsed ? "" : "open"}`}><Icon name="right" size={11} /></span>
          <h3>{title}</h3>
          {count != null && <span class="sec-count">{count}</span>}
        </button>
        {note && <span class="sec-note">{note}</span>}
        {right && <span class="sec-right">{right}</span>}
      </header>
      {!collapsed && children}
    </section>
  );
}

// ---------- small controls ----------

export function Popover({ anchor, onClose, children, align = "left" }: {
  anchor: HTMLElement | null; onClose: () => void; children: ComponentChildren; align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(300, innerWidth - 24);
    let left = align === "right" ? r.right - w : r.left;
    left = Math.max(12, Math.min(left, innerWidth - w - 12));
    let top = r.bottom + 6;
    if (top + 320 > innerHeight) top = Math.max(12, r.top - 326);
    setPos({ top, left });
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => document.addEventListener("pointerdown", close), 0);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [anchor]);
  if (!pos) return null;
  return <div class="pop" ref={ref} style={{ top: pos.top, left: pos.left }}>{children}</div>;
}

export function useAnchor() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return { el, open: (e: Event) => setEl(e.currentTarget as HTMLElement), close: () => setEl(null) };
}

/** Quick date choices relative to today. */
export function quickDates(td: ISODate, weekStart: number): { label: string; date: ISODate }[] {
  const wd = new Date(td + "T12:00:00Z").getUTCDay();
  const toSat = (6 - wd + 7) % 7 || (wd === 6 ? 0 : 7);
  const toNextWeek = ((weekStart - wd + 7) % 7) || 7;
  const add = (n: number) => {
    const d = new Date(td + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  return [
    { label: "Today", date: td },
    { label: "Tomorrow", date: add(1) },
    { label: wd === 6 || wd === 0 ? "This weekend" : "Saturday", date: add(wd === 0 ? 0 : toSat) },
    { label: "Next week", date: add(toNextWeek) },
  ];
}

export function DateField({ label, icon, date, time, onChange, accent, hint }: {
  label: string; icon: string; date: ISODate | null; time: string | null; accent: string; hint?: string;
  onChange: (date: ISODate | null, time: string | null) => void;
}) {
  const td = today();
  const [showTime, setShowTime] = useState(!!time);
  useEffect(() => setShowTime(!!time), [time]);
  return (
    <div class={`datefield ${accent}`}>
      <div class="df-head">
        <Icon name={icon} />
        <span class="df-label">{label}</span>
        {date && <span class="df-rel">{relDate(date, td)}{time ? ", " + fmtTime12(time) : ""}</span>}
        {date && <button class="link-btn" onClick={() => onChange(null, null)}>Clear</button>}
      </div>
      {hint && !date && <p class="df-hint">{hint}</p>}
      <div class="df-quick">
        {quickDates(td, store.settings.weekStart).map((q) => (
          <button class={`chip ${date === q.date ? "on" : ""}`} onClick={() => onChange(q.date, time)}>{q.label}</button>
        ))}
      </div>
      <div class="df-inputs">
        <input type="date" value={date ?? ""} aria-label={`${label} date`}
          onChange={(e) => onChange((e.currentTarget.value || null) as ISODate | null, time)} />
        {showTime || time ? (
          <input type="time" value={time ?? ""} step={300} aria-label={`${label} time`}
            onChange={(e) => onChange(date ?? td, e.currentTarget.value || null)} />
        ) : (
          <button class="link-btn" onClick={() => setShowTime(true)}>Add time</button>
        )}
      </div>
    </div>
  );
}

export function TagInput({ tags, onChange, placeholder = "Add tag" }: { tags: string[]; onChange: (t: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const all = [...tagCounts(store.tasks).keys()];
  const q = text.replace(/^#/, "").toLowerCase();
  const sugg = all.filter((t) => !tags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 8);
  const add = (t: string) => {
    const v = t.replace(/^#/, "").trim().replace(/\s+/g, "-");
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setText("");
  };
  return (
    <div class="taginput">
      {tags.map((t) => (
        <span class="tagchip" key={t}>#{t}<button aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><Icon name="x" size={10} /></button></span>
      ))}
      <div class="ti-wrap">
        <input value={text} placeholder={placeholder} onInput={(e) => setText(e.currentTarget.value)}
          onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === "," || e.key === " ") && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
          }} />
        {focus && sugg.length > 0 && (
          <div class="ti-sugg">
            {sugg.map((s) => <button key={s} onMouseDown={(e) => { e.preventDefault(); add(s); }}>#{s}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectSelect({ value, onChange, includeNone = true }: { value: string | null; onChange: (id: string | null) => void; includeNone?: boolean }) {
  const spaces = store.spaces;
  const projects = store.projects.filter((p) => !p.archived || p.id === value);
  const loose = projects.filter((p) => !p.spaceId || !spaces.some((s) => s.id === p.spaceId));
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.currentTarget.value || null)}>
      {includeNone && <option value="">No project</option>}
      {loose.map((p) => <option value={p.id}>{p.name}</option>)}
      {spaces.map((s) => {
        const ps = projects.filter((p) => p.spaceId === s.id);
        return ps.length ? <optgroup label={s.name}>{ps.map((p) => <option value={p.id}>{p.name}</option>)}</optgroup> : null;
      })}
    </select>
  );
}

export function LoadRule({ minutes, done = 0, capacity }: { minutes: number; done?: number; capacity: number }) {
  // An instrument scale: one tick per hour of the working day, the bar is planned work.
  const hours = Math.max(1, Math.round(capacity / 60));
  const pct = Math.min(1, minutes / capacity);
  const pctDone = Math.min(1, done / capacity);
  const over = minutes > capacity;
  return (
    <div class={`load ${over ? "over" : ""}`} role="img"
      aria-label={`${fmtDuration(minutes) || "No time"} planned of a ${hours}-hour day`}>
      <div class="load-scale">
        {Array.from({ length: hours + 1 }, (_, i) => <i style={{ left: `${(i / hours) * 100}%` }} class={i % 4 === 0 ? "major" : ""} />)}
        <b class="load-bar" style={{ width: `${pct * 100}%` }} />
        <b class="load-done" style={{ width: `${pctDone * 100}%` }} />
      </div>
    </div>
  );
}

export const openCount = () => store.tasks.filter(isOpen).length;

export function Empty({ children }: { children: ComponentChildren }): JSX.Element {
  return <div class="empty">{children}</div>;
}
