import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  addSubtask, deleteTask, describeRule, duplicateTask, fmtDuration, fmtTime12, longDate, parseISO, randomId, relDate,
  scheduleSubtasks, setRecurrence, shareEstimate, skipOccurrence, splitTask, spreadDates, subtasksOf, updateTask,
  weekday, WEEKDAYS, isISODate, planAfterDue, addDays,
  type Attachment, type ISODate, type Recurrence, type Reminder, type Task, type Weekday,
} from "@ephemeris/core";
import { Icon } from "./icons";
import { Check, DateField, ProjectSelect, TagInput, deleteWithUndo } from "./common";
import { api, apiJSON, connected, openTask, showToast, store, today, useAtom, useStore } from "../state";

export function TaskDetail() {
  useStore();
  const id = useAtom(openTask);
  const t = id ? store.get<Task>(id) : undefined;
  useEffect(() => {
    if (id && (!t || t.deleted)) openTask.set(null);
  }, [id, t?.deleted]);
  if (!t || t.deleted) return null;
  return <DetailBody key={t.id} t={t} />;
}

const up = (t: Task, patch: Partial<Task>) => updateTask(store, t.id, patch);

function AutoText({ value, onCommit, class: cls, placeholder, multiline }: {
  value: string; onCommit: (v: string) => void; class?: string; placeholder?: string; multiline?: boolean;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
  }, [v]);
  return (
    <textarea ref={ref} class={cls} value={v} rows={1} placeholder={placeholder}
      onInput={(e) => setV(multiline ? e.currentTarget.value : e.currentTarget.value.replace(/\n/g, " "))}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (!multiline && e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setV(value);
          (e.currentTarget as HTMLTextAreaElement).blur();
        }
      }} />
  );
}

const EST = [15, 30, 45, 60, 90, 120, 180];

function DetailBody({ t }: { t: Task }) {
  const td = today();
  const parent = t.parentId ? store.get<Task>(t.parentId) : null;
  const subs = subtasksOf(store, t.id);
  const late = planAfterDue(t);

  return (
    <aside class="detail" aria-label="Task details">
      <div class="dt-top">
        {parent ? (
          <button class="link-btn" onClick={() => openTask.set(parent.id)}><Icon name="left" size={12} /> {parent.title}</button>
        ) : <span />}
        <button class="icon-btn" aria-label="Close details" onClick={() => openTask.set(null)}><Icon name="x" /></button>
      </div>

      <div class="dt-title">
        <Check task={t} />
        <AutoText class="dt-title-input" value={t.title} placeholder="Title" onCommit={(v) => up(t, { title: v.trim() || "Untitled" })} />
        <button class={`icon-btn ${t.starred ? "ink-brass" : ""}`} aria-pressed={t.starred} aria-label="Star"
          onClick={() => up(t, { starred: !t.starred })}><Icon name="star" /></button>
      </div>

      <div class="dt-dates">
        <DateField label="Planned" icon="plan" accent="acc-plan" date={t.planned} time={t.plannedTime}
          hint="The day you intend to work on it."
          onChange={(d, tm) => up(t, { planned: d, plannedTime: d ? tm : null })} />
        <DateField label="Due" icon="due" accent="acc-due" date={t.due} time={t.dueTime}
          hint="The day it must be done by."
          onChange={(d, tm) => up(t, { due: d, dueTime: d ? tm : null })} />
      </div>
      {late && <p class="warn">The plan is after the deadline ({relDate(t.due!, td)}).</p>}

      <div class="dt-field">
        <div class="dt-label"><Icon name="clock" /> Estimate</div>
        <div class="chips">
          {EST.map((m) => <button class={`chip ${t.estimate === m ? "on" : ""}`} onClick={() => up(t, { estimate: t.estimate === m ? null : m })}>{fmtDuration(m)}</button>)}
          <input class="num" type="number" min={0} step={5} value={t.estimate ?? ""} placeholder="min" aria-label="Estimate in minutes"
            onChange={(e) => up(t, { estimate: Number(e.currentTarget.value) > 0 ? Math.round(Number(e.currentTarget.value)) : null })} />
        </div>
      </div>

      <RepeatEditor t={t} />
      <RemindersEditor t={t} />

      <div class="dt-field">
        <div class="dt-label"><Icon name="tag" /> Tags</div>
        <TagInput tags={t.tags} onChange={(tags) => up(t, { tags })} />
      </div>

      {!t.parentId && (
        <div class="dt-field">
          <div class="dt-label"><Icon name="folder" /> Project</div>
          <div class="row-ctl">
            <ProjectSelect value={t.projectId} onChange={(projectId) => up(t, { projectId })} />
            {!t.projectId && store.spaces.length > 0 && (
              <select value={t.spaceId ?? ""} aria-label="Space" onChange={(e) => up(t, { spaceId: e.currentTarget.value || null })}>
                <option value="">No space</option>
                {store.spaces.map((s) => <option value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>
        </div>
      )}

      <div class="dt-field">
        <div class="dt-label"><Icon name="sub" /> Subtasks {subs.length > 0 && <span class="dim">{subs.filter((s) => s.status !== "open").length}/{subs.length}</span>}</div>
        <div class="subs">
          {subs.map((s, i) => (
            <div class={`sub ${s.status !== "open" ? "is-done" : ""}`} key={s.id}>
              <Check task={s} />
              <AutoText value={s.title} onCommit={(v) => updateTask(store, s.id, { title: v.trim() || "Untitled" })} />
              {(s.planned || s.due) && <span class="dim small">{s.planned ? relDate(s.planned, td) : ""}{s.due ? ` due ${relDate(s.due, td)}` : ""}</span>}
              <span class="sub-acts">
                {i > 0 && <button class="icon-btn" aria-label="Move up" onClick={() => {
                  const prev = subs[i - 1];
                  store.batch(() => {
                    updateTask(store, s.id, { order: prev.order });
                    updateTask(store, prev.id, { order: s.order });
                  });
                }}><Icon name="up" size={12} /></button>}
                <button class="icon-btn" aria-label="Open subtask" onClick={() => openTask.set(s.id)}><Icon name="right" size={12} /></button>
              </span>
            </div>
          ))}
          <NewLine placeholder="Add subtask" onAdd={(v) => addSubtask(store, t.id, v)} />
        </div>
        {!t.parentId && t.status === "open" && <SplitPanel t={t} subs={subs} />}
      </div>

      <div class="dt-field">
        <div class="dt-label"><Icon name="log" /> Notes</div>
        <AutoText class="notes" multiline value={t.notes} placeholder="Notes" onCommit={(notes) => up(t, { notes })} />
      </div>

      <LinksEditor t={t} />
      <LocationEditor t={t} />
      <AttachmentsEditor t={t} />

      <footer class="dt-foot">
        <span class="dim small">Created {longDate(t.createdAt.slice(0, 10) as ISODate)}{t.completedAt ? `, completed ${new Date(t.completedAt).toLocaleString()}` : ""}</span>
        <div class="dt-actions">
          {t.recurrence && t.status === "open" && (
            <button class="btn" onClick={() => {
              const n = skipOccurrence(store, t.id, td);
              if (n) {
                openTask.set(n.id);
                showToast(`Skipped. Next: ${relDate((n.due ?? n.planned)!, td)}`);
              }
            }}><Icon name="skip" /> Skip this one</button>
          )}
          <button class="btn" onClick={() => {
            const c = duplicateTask(store, t.id);
            if (c) openTask.set(c.id);
          }}><Icon name="copy" /> Duplicate</button>
          <button class="btn danger" onClick={() => deleteWithUndo([t.id])}><Icon name="trash" /> Delete</button>
        </div>
      </footer>
    </aside>
  );
}

// ---------- split into sections ----------

/** Split a task into sections, each planned on its own day. Sections are subtasks. */
function SplitPanel({ t, subs }: { t: Task; subs: Task[] }) {
  const td = today();
  const openSubs = subs.filter((s) => s.status === "open");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [parts, setParts] = useState(3);
  const [start, setStart] = useState<string>(t.planned && t.planned >= td ? t.planned : td);
  const [end, setEnd] = useState<string>(t.due && t.due >= td ? t.due : "");
  const [weekends, setWeekends] = useState(false);

  const titles = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const count = titles.length || Math.max(1, Math.min(30, parts));
  const first = isISODate(start) ? start : td;
  const last = isISODate(end) && end >= first ? end : addDays(first, Math.max(0, count - 1));
  const opts = { start: first, end: last, skipWeekends: !weekends };
  const dates = spreadDates(count, opts);
  const est = shareEstimate(t.estimate, count);
  const shown = titles.length ? titles : Array.from({ length: count }, (_, i) => `Part ${i + 1}`);
  const lateEnd = !!(t.due && last > t.due);

  const undoFor = (ids: string[], before: Partial<Task>) => () =>
    store.batch(() => {
      ids.forEach((id) => deleteTask(store, id));
      updateTask(store, t.id, before);
    });

  const doSplit = () => {
    const before = { planned: t.planned, plannedTime: t.plannedTime };
    const made = splitTask(store, t.id, shown.map((title) => ({ title })), opts);
    if (!made.length) return showToast("Could not split this task");
    showToast(`Split into ${made.length} sections`, undoFor(made.map((m) => m.id), before));
    setText("");
    setOpen(false);
  };

  const doSchedule = () => {
    const before = openSubs.map((s) => ({ id: s.id, planned: s.planned }));
    const parentBefore = { planned: t.planned, plannedTime: t.plannedTime };
    const changed = scheduleSubtasks(store, t.id, opts);
    if (!changed.length) return;
    showToast(`Planned ${changed.length} sections`, () =>
      store.batch(() => {
        before.forEach((b) => updateTask(store, b.id, { planned: b.planned }));
        updateTask(store, t.id, parentBefore);
      }));
    setOpen(false);
  };

  if (!open)
    return (
      <div class="row-ctl">
        <button class="btn" onClick={() => setOpen(true)}><Icon name="sub" /> Split into sections</button>
      </div>
    );

  return (
    <div class="split-panel">
      <p class="dim small">Each section is a subtask with its own planned date. The deadline stays on this task.</p>
      <textarea class="notes" rows={4} value={text} placeholder={"One section per line, for example:\nOutline\nDraft\nEdit"}
        aria-label="Section titles" onInput={(e) => setText(e.currentTarget.value)} />
      <div class="row-ctl wrap">
        {titles.length === 0 && (
          <label class="inline">or
            <input class="num" type="number" min={1} max={30} value={parts} aria-label="Number of sections"
              onChange={(e) => setParts(Math.max(1, Math.min(30, Math.round(Number(e.currentTarget.value)) || 1)))} />
            equal parts
          </label>
        )}
        <label class="inline">from
          <input type="date" value={start} onChange={(e) => isISODate(e.currentTarget.value) && setStart(e.currentTarget.value)} />
        </label>
        <label class="inline">to
          <input type="date" value={end} onChange={(e) => setEnd(isISODate(e.currentTarget.value) ? e.currentTarget.value : "")} />
        </label>
        <label class="inline"><input type="checkbox" checked={weekends} onChange={(e) => setWeekends(e.currentTarget.checked)} />
          include weekends</label>
      </div>
      <ol class="split-preview">
        {shown.map((title, i) => (
          <li key={i}>
            <span class="split-title">{title}</span>
            <span class="dim small">{relDate(dates[i], td)}{est[i] ? `, ${fmtDuration(est[i])}` : ""}</span>
          </li>
        ))}
      </ol>
      {lateEnd && <p class="warn">The last section is after the deadline ({relDate(t.due!, td)}).</p>}
      <div class="row-ctl wrap">
        <button class="btn primary" onClick={doSplit}>Split and plan</button>
        {openSubs.length > 0 && (
          <button class="btn" onClick={doSchedule}>Only plan the {openSubs.length} existing subtask{openSubs.length > 1 ? "s" : ""}</button>
        )}
        <button class="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function NewLine({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <input class="newline" value={v} placeholder={placeholder} onInput={(e) => setV(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) {
          onAdd(v.trim());
          setV("");
        }
      }} />
  );
}

// ---------- repeat ----------

const WD_ORDER: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WD_SHORT: Record<Weekday, string> = { MO: "M", TU: "T", WE: "W", TH: "T", FR: "F", SA: "S", SU: "S" };
const ORDW = ["", "first", "second", "third", "fourth", "fifth"];

function RepeatEditor({ t }: { t: Task }) {
  const r = t.recurrence;
  const anchor = (t.due ?? t.planned ?? today()) as ISODate;
  const a = parseISO(anchor);
  const awd = WEEKDAYS[weekday(anchor)];
  const nth = Math.ceil(a.d / 7);
  const set = (patch: Partial<Recurrence> | null) => {
    if (!patch) return setRecurrence(store, t.id, null);
    const base: Recurrence = r ?? { freq: "weekly", interval: 1, mode: "schedule", start: anchor };
    const next = { ...base, ...patch };
    for (const k of Object.keys(next) as (keyof Recurrence)[]) if (next[k] === undefined) delete next[k];
    setRecurrence(store, t.id, next);
  };
  const monthlyMode = r?.byNthDay?.length ? "nth" : r?.byMonthDay?.[0] === -1 ? "last" : "day";
  const unit = r ? { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq] : "";
  return (
    <div class="dt-field">
      <div class="dt-label"><Icon name="repeat" /> Repeat {r && <span class="rep-sum">{describeRule(r)}</span>}</div>
      <div class="row-ctl wrap">
        <select value={r?.freq ?? ""} aria-label="Repeat frequency" onChange={(e) => {
          const f = e.currentTarget.value as Recurrence["freq"] | "";
          if (!f) return set(null);
          set({ freq: f, byDay: f === "weekly" ? [awd] : undefined, byMonthDay: undefined, byNthDay: undefined, byMonth: undefined, start: anchor });
        }}>
          <option value="">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
        {r && (
          <label class="inline">every
            <input class="num" type="number" min={1} max={99} value={r.interval}
              onChange={(e) => set({ interval: Math.max(1, Number(e.currentTarget.value) || 1) })} />
            {unit}{r.interval > 1 ? "s" : ""}
          </label>
        )}
      </div>
      {r && r.freq === "weekly" && r.mode === "schedule" && (
        <div class="wdays" role="group" aria-label="Weekdays">
          {WD_ORDER.map((d) => {
            const on = (r.byDay ?? [awd]).includes(d);
            return <button class={`wd ${on ? "on" : ""}`} aria-pressed={on} aria-label={d} onClick={() => {
              const cur = r.byDay ?? [awd];
              const next = on ? cur.filter((x) => x !== d) : [...cur, d];
              if (next.length) set({ byDay: next });
            }}>{WD_SHORT[d]}</button>;
          })}
        </div>
      )}
      {r && r.freq === "monthly" && r.mode === "schedule" && (
        <div class="row-ctl wrap">
          <select value={monthlyMode} aria-label="Monthly pattern" onChange={(e) => {
            const m = e.currentTarget.value;
            if (m === "day") set({ byMonthDay: [a.d], byNthDay: undefined });
            if (m === "nth") set({ byNthDay: [{ day: awd, n: nth > 4 ? -1 : nth }], byMonthDay: undefined });
            if (m === "last") set({ byMonthDay: [-1], byNthDay: undefined });
          }}>
            <option value="day">on day {r.byMonthDay?.[0] && r.byMonthDay[0] > 0 ? r.byMonthDay[0] : a.d}</option>
            <option value="nth">on the {nth > 4 ? "last" : ORDW[nth]} {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday(anchor)]}</option>
            <option value="last">on the last day</option>
          </select>
        </div>
      )}
      {r && (
        <div class="row-ctl wrap">
          <select value={r.mode} aria-label="Repeat basis" onChange={(e) => set({ mode: e.currentTarget.value as Recurrence["mode"] })}>
            <option value="schedule">on a fixed schedule</option>
            <option value="completion">counted from completion</option>
          </select>
          <select value={r.until ? "until" : r.count ? "count" : "never"} aria-label="Repeat end" onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "never") set({ until: null, count: null });
            if (v === "until") set({ until: anchor, count: null });
            if (v === "count") set({ count: 10, until: null });
          }}>
            <option value="never">forever</option>
            <option value="until">until a date</option>
            <option value="count">a number of times</option>
          </select>
          {r.until && <input type="date" value={r.until} onChange={(e) => isISODate(e.currentTarget.value) && set({ until: e.currentTarget.value })} />}
          {r.count != null && r.count > 0 && <label class="inline"><input class="num" type="number" min={1} value={r.count} onChange={(e) => set({ count: Math.max(1, Number(e.currentTarget.value) || 1) })} />times (this is #{t.occurrence})</label>}
        </div>
      )}
      {r && <p class="dim small">When you complete it, the next one is created. {t.due && t.planned ? "The planned date keeps its distance to the deadline." : ""}</p>}
    </div>
  );
}

// ---------- reminders ----------

function describeReminder(r: Reminder, t: Task): string {
  if (r.at) return `${relDate(r.at.date, today())} at ${fmtTime12(r.at.time)}`;
  const anchor = r.anchor ?? "planned";
  const hasTime = anchor === "due" ? !!t.dueTime : !!t.plannedTime;
  const base = anchor === "due" ? "deadline" : "planned time";
  const off = r.offset ?? 0;
  const lead = off === 0 ? "At" : off % 1440 === 0 ? `${off / 1440} day${off > 1440 ? "s" : ""} before` : `${fmtDuration(off)} before`;
  const txt = off === 0 ? `At ${base}` : `${lead} ${base}`;
  return hasTime ? txt : `${txt} (${fmtTime12(store.settings.allDayTime)} on the day, no time set)`;
}

const PRESETS: { label: string; r: Omit<Reminder, "id"> }[] = [
  { label: "At planned time", r: { anchor: "planned", offset: 0 } },
  { label: "15 min before planned", r: { anchor: "planned", offset: 15 } },
  { label: "1 hour before planned", r: { anchor: "planned", offset: 60 } },
  { label: "At deadline", r: { anchor: "due", offset: 0 } },
  { label: "1 hour before deadline", r: { anchor: "due", offset: 60 } },
  { label: "1 day before deadline", r: { anchor: "due", offset: 1440 } },
  { label: "2 days before deadline", r: { anchor: "due", offset: 2880 } },
];

function RemindersEditor({ t }: { t: Task }) {
  const [custom, setCustom] = useState(false);
  const [cd, setCd] = useState<string>(today());
  const [ct, setCt] = useState("09:00");
  const add = (r: Omit<Reminder, "id">) => up(t, { reminders: [...t.reminders, { id: randomId(8), ...r }] });
  const s = store.settings;
  const auto: string[] = [];
  if (s.autoPlannedOffset != null && t.plannedTime) auto.push(s.autoPlannedOffset ? `${fmtDuration(s.autoPlannedOffset)} before planned time` : "at planned time");
  if (s.autoDueOffset != null && t.dueTime) auto.push(`${fmtDuration(s.autoDueOffset)} before deadline`);
  if (s.dueEveTime && t.due) auto.push(`evening before the deadline (${fmtTime12(s.dueEveTime)})`);
  return (
    <div class="dt-field">
      <div class="dt-label"><Icon name="bell" /> Reminders</div>
      {t.reminders.map((r) => (
        <div class="rem" key={r.id}>
          <span>{describeReminder(r, t)}</span>
          <button class="icon-btn" aria-label="Remove reminder" onClick={() => up(t, { reminders: t.reminders.filter((x) => x.id !== r.id) })}><Icon name="x" size={12} /></button>
        </div>
      ))}
      <div class="row-ctl wrap">
        <select value="" aria-label="Add reminder" onChange={(e) => {
          const v = e.currentTarget.value;
          e.currentTarget.value = "";
          if (v === "custom") return setCustom(true);
          const p = PRESETS[Number(v)];
          if (p) add(p.r);
        }}>
          <option value="">Add reminder</option>
          {PRESETS.map((p, i) => <option value={String(i)} disabled={(p.r.anchor === "due" ? !t.due : !t.planned)}>{p.label}</option>)}
          <option value="custom">On a date and time</option>
        </select>
        {custom && (
          <>
            <input type="date" value={cd} onChange={(e) => setCd(e.currentTarget.value)} />
            <input type="time" value={ct} onChange={(e) => setCt(e.currentTarget.value)} />
            <button class="btn" onClick={() => {
              if (isISODate(cd) && ct) add({ at: { date: cd, time: ct } });
              setCustom(false);
            }}>Add</button>
          </>
        )}
      </div>
      {auto.length > 0 && <p class="dim small">Also, from Settings: {auto.join("; ")}.</p>}
    </div>
  );
}

// ---------- links, location, files ----------

function LinksEditor({ t }: { t: Task }) {
  const [v, setV] = useState("");
  const add = () => {
    let url = v.trim();
    if (!url) return;
    if (!/^[a-z][\w+.-]*:/i.test(url)) url = "https://" + url;
    try {
      new URL(url);
    } catch {
      return showToast("That is not a valid link");
    }
    up(t, { links: [...t.links, { url }] });
    setV("");
  };
  return (
    <div class="dt-field">
      <div class="dt-label"><Icon name="link" /> Links</div>
      {t.links.map((l, i) => (
        <div class="rem" key={l.url + i}>
          <a href={l.url} target="_blank" rel="noopener noreferrer">{l.title || l.url.replace(/^https?:\/\//, "")}</a>
          <button class="icon-btn" aria-label="Remove link" onClick={() => up(t, { links: t.links.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button>
        </div>
      ))}
      <input class="newline" value={v} placeholder="Paste a link (arXiv, Canvas, a doc)" inputMode="url"
        onInput={(e) => setV(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && add()} onBlur={add} />
    </div>
  );
}

function LocationEditor({ t }: { t: Task }) {
  const [v, setV] = useState(t.location?.name ?? "");
  useEffect(() => setV(t.location?.name ?? ""), [t.location?.name]);
  const q = encodeURIComponent(t.location?.address || t.location?.name || "");
  return (
    <div class="dt-field">
      <div class="dt-label"><Icon name="pin" /> Location</div>
      <input class="newline" value={v} placeholder="Place or address (e.g. Phillips Hall 265)"
        onInput={(e) => setV(e.currentTarget.value)}
        onBlur={() => up(t, { location: v.trim() ? { name: v.trim() } : null })}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
      {t.location && (
        <div class="maplinks">
          <a href={`https://maps.apple.com/?q=${q}`} target="_blank" rel="noopener noreferrer">Open in Apple Maps</a>
          <a href={`https://www.google.com/maps/search/?api=1&query=${q}`} target="_blank" rel="noopener noreferrer">Google Maps</a>
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function AttachmentsEditor({ t }: { t: Task }) {
  const [busy, setBusy] = useState(false);
  const can = connected();
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const added: Attachment[] = [];
      for (const f of Array.from(files)) {
        if (f.size > 25 * 1024 * 1024) {
          showToast(`${f.name} is larger than 25 MB`);
          continue;
        }
        const meta = await apiJSON<Attachment>("/api/files", {
          method: "POST",
          headers: { "Content-Type": f.type || "application/octet-stream", "X-File-Name": encodeURIComponent(f.name) },
          body: f,
        });
        added.push(meta);
      }
      const cur = store.get<Task>(t.id)!;
      up(cur, { attachments: [...cur.attachments, ...added] });
    } catch (e: any) {
      showToast(`Upload failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  const open = async (a: Attachment) => {
    const w = window.open("", "_blank");
    try {
      const r = await api(`/api/files/${a.id}`);
      if (!r.ok) throw new Error(String(r.status));
      const url = URL.createObjectURL(await r.blob());
      if (w) w.location.href = url;
      else location.href = url;
    } catch (e: any) {
      w?.close();
      showToast(`Could not open ${a.name}: ${e.message}`);
    }
  };
  return (
    <div class="dt-field">
      <div class="dt-label"><Icon name="clip" /> Attachments</div>
      {t.attachments.map((a) => (
        <div class="rem" key={a.id}>
          <button class="link-btn" onClick={() => open(a)}><Icon name="file" size={12} /> {a.name}</button>
          <span class="dim small">{fmtSize(a.size)}</span>
          <button class="icon-btn" aria-label="Remove attachment" onClick={() => {
            up(t, { attachments: t.attachments.filter((x) => x.id !== a.id) });
            void api(`/api/files/${a.id}`, { method: "DELETE" });
          }}><Icon name="x" size={12} /></button>
        </div>
      ))}
      {can ? (
        <label class={`btn file-btn ${busy ? "busy" : ""}`}>
          <Icon name="plus" /> {busy ? "Uploading" : "Attach files"}
          <input type="file" multiple onChange={(e) => upload(e.currentTarget.files)} disabled={busy} />
        </label>
      ) : (
        <p class="dim small">Connect your server in Settings to attach files.</p>
      )}
    </div>
  );
}
