import { useState } from "preact/hooks";
import {
  addDays, bulkUpdate, filterTasks, fmtDuration, inbox, isOpen, logbook, longDate, parseHM, relDate, renameTag,
  deleteTag, tagCounts, todayView, totalEstimate, unplanned, upcoming, updateTask, weekday, WEEKDAY_NAMES,
  MONTH_NAMES, parseISO, byPlan, byDue, type Filter, type ISODate, type Project, type Space, type Task,
} from "@ephemeris/core";
import { Icon } from "./icons";
import { Empty, LoadRule, ProjectSelect, Section, TaskList } from "./common";
import { QuickAdd } from "./quickadd";
import { go, showToast, store, today, useStore } from "../state";

const capacity = () => {
  const s = store.settings;
  return Math.max(60, parseHM(s.dayEnd) - parseHM(s.dayStart));
};

function PlanButtons({ t, days = [0, 1] }: { t: Task; days?: number[] }) {
  const td = today();
  return (
    <>
      {days.map((n) => (
        <button class="mini" onClick={() => updateTask(store, t.id, { planned: addDays(td, n) })}>
          {n === 0 ? "Today" : n === 1 ? "Tomorrow" : relDate(addDays(td, n), td)}
        </button>
      ))}
    </>
  );
}

export function Header({ title, sub, children }: { title: string; sub?: preact.ComponentChildren; children?: preact.ComponentChildren }) {
  return (
    <header class="vh">
      <h1>{title}</h1>
      {sub && <div class="vh-sub">{sub}</div>}
      {children}
    </header>
  );
}

// ---------- Today ----------

export function TodayView() {
  useStore();
  const td = today();
  const v = todayView(store.tasks, td);
  const top = (ts: Task[]) => ts;
  const cap = capacity();
  const nothing = !v.overdue.length && !v.planned.length && !v.dueToday.length && !v.carried.length;
  return (
    <div class="view">
      <Header title="Today" sub={longDate(td)}>
        <div class="vh-load">
          <LoadRule minutes={v.load} done={v.loadDone} capacity={cap} />
          <p class="load-text">
            {v.load ? <>{fmtDuration(v.load)} of planned work{v.loadDone ? <>, {fmtDuration(v.loadDone)} done</> : null}</> : "No estimates on today's plan"}
            {v.load > cap && <span class="late-text"> exceeds your {fmtDuration(cap)} day</span>}
          </p>
        </div>
      </Header>
      <QuickAdd defaults={{ planned: td }} />

      {v.overdue.length > 0 && (
        <Section title="Overdue" cls="sec-late" count={v.overdue.length} note="Deadline has passed">
          <TaskList tasks={top(v.overdue)} opts={{ day: td, actions: (t) => t.planned !== td && <PlanButtons t={t} days={[0]} /> }} />
        </Section>
      )}
      {v.dueToday.length > 0 && (
        <Section title="Due today" cls="sec-due" count={v.dueToday.length} note="Not planned for today">
          <TaskList tasks={v.dueToday} opts={{ day: td, actions: (t) => <PlanButtons t={t} days={[0]} /> }} />
        </Section>
      )}
      <Section title="Planned" count={v.planned.length} note={v.planned.length ? fmtDuration(totalEstimate(v.planned)) : undefined}>
        <TaskList tasks={v.planned} opts={{ day: td }} empty={nothing ? "Nothing is planned for today. Add a task above, or plan one from the list below." : "Nothing else is planned for today."} />
      </Section>
      {v.carried.length > 0 && (
        <Section title="Carried over" count={v.carried.length} note="Planned for an earlier day, not done"
          right={<button class="link-btn" onClick={() => {
            bulkUpdate(store, v.carried.map((t) => t.id), { planned: td });
            showToast(`Moved ${v.carried.length} to today`);
          }}>Move all to today</button>}>
          <TaskList tasks={v.carried} opts={{ actions: (t) => <PlanButtons t={t} /> }} />
        </Section>
      )}
      {v.needsPlan.length > 0 && (
        <Section title="Needs a plan" count={v.needsPlan.length} note="Deadline within a week, no plan before it">
          <TaskList tasks={v.needsPlan} opts={{ actions: (t) => <PlanButtons t={t} /> }} />
        </Section>
      )}
      {v.doneToday.length > 0 && (
        <Section title="Done today" collapsed count={v.doneToday.length}>
          <TaskList tasks={v.doneToday} opts={{ day: td }} />
        </Section>
      )}
    </div>
  );
}

// ---------- Upcoming ----------

export function UpcomingView() {
  useStore();
  const td = today();
  const [span, setSpan] = useState(21);
  const days = upcoming(store.tasks, addDays(td, 1), span);
  const cap = capacity();
  const lastDay = addDays(td, span);
  const later = store.tasks.filter((t) => isOpen(t) && t.planned && t.planned > lastDay).sort((a, b) => (a.planned! < b.planned! ? -1 : 1));
  return (
    <div class="view">
      <Header title="Upcoming" sub="Plans by day; deadlines are marked on their day" />
      <QuickAdd placeholder="Plan something: draft abstract thu 2pm for 1h due next mon" />
      {days.map((d) => {
        const wd = weekday(d.date);
        const { m, d: dn } = parseISO(d.date);
        const empty = !d.planned.length && !d.deadlines.length && !d.ghosts.length;
        const gPlan = d.ghosts.filter((g) => g.kind === "planned").map((g) => g.task);
        const gDue = d.ghosts.filter((g) => g.kind === "due").map((g) => g.task);
        return (
          <section class={`day ${empty ? "is-empty" : ""} ${wd === 0 || wd === 6 ? "is-weekend" : ""}`} key={d.date}>
            <header class="day-head">
              <span class="day-num">{dn}</span>
              <span class="day-name">{relDate(d.date, td) === "Tomorrow" ? "Tomorrow" : WEEKDAY_NAMES[wd]}</span>
              <span class="day-month">{MONTH_NAMES[m - 1]}</span>
              {d.load > 0 && <span class="day-load"><LoadRule minutes={d.load} capacity={cap} /><span>{fmtDuration(d.load)}</span></span>}
            </header>
            {!empty && (
              <div class="list" role="list">
                <TaskList tasks={d.planned} opts={{ day: d.date }} />
                <TaskList tasks={gPlan} opts={{ day: d.date, ghost: true }} />
                <TaskList tasks={d.deadlines} opts={{ day: d.date, marker: true }} />
                <TaskList tasks={gDue} opts={{ day: d.date, marker: true, ghost: true }} />
              </div>
            )}
          </section>
        );
      })}
      <div class="more"><button class="link-btn" onClick={() => setSpan(span + 21)}>Show three more weeks</button></div>
      {later.length > 0 && (
        <Section title="Later" collapsed count={later.length}>
          <TaskList tasks={later} />
        </Section>
      )}
    </div>
  );
}

// ---------- Inbox / Backlog ----------

export function InboxView() {
  useStore();
  const ts = inbox(store.tasks);
  return (
    <div class="view">
      <Header title="Inbox" sub="No date and no project yet" />
      <QuickAdd placeholder="Capture anything; sort it later" />
      <TaskList tasks={ts} empty="Inbox is clear." />
    </div>
  );
}

export function BacklogView() {
  useStore();
  const ts = unplanned(store.tasks);
  const withDue = ts.filter((t) => t.due);
  const without = ts.filter((t) => !t.due);
  return (
    <div class="view">
      <Header title="Unplanned" sub="Open tasks with no planned day" />
      {withDue.length > 0 && (
        <Section title="With a deadline" count={withDue.length}>
          <TaskList tasks={withDue} opts={{ actions: (t) => <PlanButtons t={t} /> }} />
        </Section>
      )}
      <Section title="No deadline" count={without.length}>
        <TaskList tasks={without} opts={{ actions: (t) => <PlanButtons t={t} /> }} empty="Every open task has a plan." />
      </Section>
    </div>
  );
}

// ---------- Project / Space ----------

export function ProjectView({ id }: { id: string }) {
  useStore();
  const p = store.get<Project>(id);
  const [showDone, setShowDone] = useState(false);
  if (!p || p.deleted) return <div class="view"><Empty>This project no longer exists.</Empty></div>;
  const all = store.tasks.filter((t) => t.projectId === id && !t.parentId);
  const open = all.filter(isOpen);
  const dated = open.filter((t) => t.planned || t.due).sort((a, b) => ((a.planned ?? a.due)! < (b.planned ?? b.due)! ? -1 : 1));
  const undated = open.filter((t) => !t.planned && !t.due).sort(byPlan);
  const done = all.filter((t) => t.status !== "open").sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1)).slice(0, 50);
  return (
    <div class="view">
      <header class="vh">
        <div class="vh-edit">
          <i class="swatch" style={{ background: p.color }} />
          <input class="h1-input" value={p.name} aria-label="Project name"
            onChange={(e) => store.update<Project>(id, { name: e.currentTarget.value.trim() || p.name })} />
        </div>
        <div class="vh-sub row-ctl">
          <select value={p.spaceId ?? ""} aria-label="Space" onChange={(e) => {
            const spaceId = e.currentTarget.value || null;
            store.batch(() => {
              store.update<Project>(id, { spaceId });
              all.forEach((t) => updateTask(store, t.id, { spaceId }));
            });
          }}>
            <option value="">No space</option>
            {store.spaces.map((s) => <option value={s.id}>{s.name}</option>)}
          </select>
          <span class="dim">{open.length} open, {fmtDuration(totalEstimate(open)) || "no"} estimated</span>
          <button class="link-btn" onClick={() => {
            if (confirm(`Archive "${p.name}"? Its tasks stay; the project leaves the sidebar.`)) {
              store.update<Project>(id, { archived: true });
              go("today");
            }
          }}>Archive</button>
        </div>
      </header>
      <QuickAdd defaults={{ projectId: id }} placeholder={`Add to ${p.name}`} />
      {dated.length > 0 && <Section title="Scheduled" count={dated.length}><TaskList tasks={dated} opts={{ hideProject: true }} /></Section>}
      <Section title="Not scheduled" count={undated.length}>
        <TaskList tasks={undated} opts={{ hideProject: true }} empty="No unscheduled tasks." />
      </Section>
      {done.length > 0 && (
        <div class="more"><button class="link-btn" onClick={() => setShowDone(!showDone)}>{showDone ? "Hide" : "Show"} completed ({done.length})</button></div>
      )}
      {showDone && <TaskList tasks={done} opts={{ hideProject: true }} />}
    </div>
  );
}

export function SpaceView({ id }: { id: string }) {
  useStore();
  const s = store.get<Space>(id);
  if (!s || s.deleted) return <div class="view"><Empty>This space no longer exists.</Empty></div>;
  const projects = store.projects.filter((p) => p.spaceId === id && !p.archived);
  const loose = store.tasks.filter((t) => isOpen(t) && t.spaceId === id && !t.projectId && !t.parentId).sort(byDue);
  return (
    <div class="view">
      <header class="vh">
        <div class="vh-edit">
          <Icon name="space" />
          <input class="h1-input" value={s.name} aria-label="Space name"
            onChange={(e) => store.update<Space>(id, { name: e.currentTarget.value.trim() || s.name })} />
        </div>
      </header>
      <QuickAdd defaults={{ spaceId: id }} placeholder={`Add to ${s.name}`} />
      {projects.map((p) => {
        const ts = store.tasks.filter((t) => isOpen(t) && t.projectId === p.id && !t.parentId).sort(byDue);
        return (
          <Section key={p.id} title={p.name} count={ts.length} right={<button class="link-btn" onClick={() => go("project", p.id)}>Open</button>}>
            <TaskList tasks={ts} opts={{ hideProject: true }} empty="No open tasks." />
          </Section>
        );
      })}
      <Section title="No project" count={loose.length}>
        <TaskList tasks={loose} empty="Nothing here." />
      </Section>
    </div>
  );
}

// ---------- Tags ----------

export function TagView({ tag }: { tag: string }) {
  useStore();
  const ts = filterTasks(store.tasks, { tags: [tag] }).sort(byDue);
  return (
    <div class="view">
      <Header title={`#${tag}`} sub={`${ts.length} open, ${fmtDuration(totalEstimate(ts)) || "no time"} estimated`}>
        <div class="row-ctl">
          <button class="link-btn" onClick={() => {
            const to = prompt(`Rename #${tag} (nested tags move too)`, tag);
            if (to && to !== tag) {
              renameTag(store, tag, to);
              go("tag", to.replace(/^#/, ""));
            }
          }}>Rename</button>
          <button class="link-btn danger" onClick={() => {
            if (confirm(`Remove #${tag} from every task?`)) {
              deleteTag(store, tag);
              go("tags");
            }
          }}>Remove from all tasks</button>
        </div>
      </Header>
      <QuickAdd defaults={{ tags: [tag] }} placeholder={`Add with #${tag}`} />
      <TaskList tasks={ts} empty="No open tasks with this tag." />
    </div>
  );
}

export function TagsView() {
  useStore();
  const counts = tagCounts(store.tasks);
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState<"any" | "all">("any");
  const results = picked.length ? filterTasks(store.tasks, { tags: picked, tagMode: mode }).sort(byDue) : [];
  return (
    <div class="view">
      <Header title="Tags" sub="Pick tags to filter; nested tags include their children" />
      {counts.size === 0 && <Empty>No tags yet. Type #something in a new task.</Empty>}
      <div class="tagcloud">
        {[...counts.entries()].map(([t, n]) => {
          const depth = t.split("/").length - 1;
          const on = picked.includes(t);
          return (
            <div class="tagline" style={{ paddingLeft: `${depth * 18}px` }} key={t}>
              <button class={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== t) : [...picked, t])}>
                #{depth ? t.split("/").pop() : t}
              </button>
              <span class="dim small">{n}</span>
              <button class="link-btn small" onClick={() => go("tag", t)}>Open</button>
            </div>
          );
        })}
      </div>
      {picked.length > 0 && (
        <>
          <div class="row-ctl filterbar">
            <span>Tasks with</span>
            <select value={mode} onChange={(e) => setMode(e.currentTarget.value as "any" | "all")}>
              <option value="any">any of</option>
              <option value="all">all of</option>
            </select>
            <span>{picked.map((p) => "#" + p).join(", ")}</span>
            <button class="link-btn" onClick={() => setPicked([])}>Clear</button>
          </div>
          <TaskList tasks={results} empty="No open tasks match." />
        </>
      )}
    </div>
  );
}

// ---------- Search ----------

export function SearchView({ q }: { q?: string }) {
  useStore();
  const [f, setF] = useState<Filter>({ text: q ?? "", status: "open", tags: [], tagMode: "any" });
  const tags = [...tagCounts(store.tasks).keys()];
  const res = filterTasks(store.tasks, { ...f, includeSubtasks: true }).sort(byDue).slice(0, 300);
  return (
    <div class="view">
      <Header title="Find" />
      <div class="searchbox">
        <Icon name="search" />
        <input autoFocus value={f.text} placeholder="Words in the title, notes or tags"
          onInput={(e) => setF({ ...f, text: e.currentTarget.value })} aria-label="Search" />
      </div>
      <div class="row-ctl wrap filterbar">
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.currentTarget.value as Filter["status"] })} aria-label="Status">
          <option value="open">Open</option>
          <option value="done">Completed</option>
          <option value="all">All</option>
        </select>
        <ProjectSelect value={f.projectId ?? null} onChange={(projectId) => setF({ ...f, projectId })} />
        <select value={f.tags?.[0] ?? ""} onChange={(e) => setF({ ...f, tags: e.currentTarget.value ? [e.currentTarget.value] : [] })} aria-label="Tag">
          <option value="">Any tag</option>
          {tags.map((t) => <option value={t}>#{t}</option>)}
        </select>
        <select value={f.has ?? ""} onChange={(e) => setF({ ...f, has: (e.currentTarget.value || null) as Filter["has"] })} aria-label="Dates">
          <option value="">Any dates</option>
          <option value="due">Has a deadline</option>
          <option value="planned">Has a plan</option>
          <option value="none">No dates</option>
          <option value="estimate">Has an estimate</option>
        </select>
        <label class="inline"><input type="checkbox" checked={!!f.starred} onChange={(e) => setF({ ...f, starred: e.currentTarget.checked })} /> Starred</label>
      </div>
      <p class="dim small">{res.length} tasks, {fmtDuration(totalEstimate(res)) || "no time"} estimated</p>
      <TaskList tasks={res} empty="No tasks match." />
    </div>
  );
}

// ---------- Logbook ----------

export function LogbookView() {
  useStore();
  const ts = logbook(store.tasks);
  const groups = new Map<string, Task[]>();
  for (const t of ts) {
    const d = new Date(t.completedAt!);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const td = today();
  return (
    <div class="view">
      <Header title="Logbook" sub="Completed and skipped tasks" />
      {ts.length === 0 && <Empty>Completed tasks will collect here.</Empty>}
      {[...groups.entries()].map(([d, list]) => (
        <Section key={d} title={relDate(d as ISODate, td) === "Today" || relDate(d as ISODate, td) === "Yesterday" ? relDate(d as ISODate, td) : longDate(d as ISODate)}
          count={list.length} note={fmtDuration(totalEstimate(list)) || undefined}>
          <TaskList tasks={list} />
        </Section>
      ))}
    </div>
  );
}
