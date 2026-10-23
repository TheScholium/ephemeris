import { useEffect, useState } from "preact/hooks";
import { completeWithUndo } from "./ui/common";
import { Icon } from "./ui/icons";
import { QuickAdd, quickAddFocus } from "./ui/quickadd";
import { TaskDetail } from "./ui/detail";
import { BulkBar } from "./ui/bulk";
import { CalendarView } from "./ui/calendar";
import { SettingsView } from "./ui/settings";
import {
  BacklogView, InboxView, LogbookView, ProjectView, SearchView, SpaceView, TagView, TagsView, TodayView, UpcomingView,
} from "./ui/views";
import {
  clearSelection, go, isWide, openTask, route, selectMode, selection, store, syncNow, syncState, toast, today,
  toggleSelect, useAtom, useStore,
} from "./state";
import { inbox, isOpen, tagCounts, todayView, updateTask, type Task } from "@ephemeris/core";

function NavItem({ view, arg, icon, label, count, onNav }: { view: string; arg?: string; icon: string; label: string; count?: number; onNav?: () => void }) {
  const r = useAtom(route);
  const active = r.view === view && (r.arg ?? "") === (arg ?? "");
  return (
    <a class={`nav ${active ? "on" : ""}`} href={`#/${view}${arg ? "/" + encodeURIComponent(arg) : ""}`} aria-current={active ? "page" : undefined} onClick={onNav}>
      <Icon name={icon} />
      <span class="nav-label">{label}</span>
      {count ? <span class="nav-count">{count}</span> : null}
    </a>
  );
}

function Sidebar({ onNav }: { onNav?: () => void }) {
  useStore();
  const sync = useAtom(syncState);
  const td = today();
  const v = todayView(store.tasks, td);
  const todayN = v.overdue.length + v.planned.length + v.dueToday.length + v.carried.length;
  const projects = store.projects.filter((p) => !p.archived);
  const spaces = store.spaces;
  const loose = projects.filter((p) => !p.spaceId || !spaces.some((s) => s.id === p.spaceId));
  const openIn = (pid: string) => store.tasks.filter((t) => isOpen(t) && t.projectId === pid && !t.parentId).length;
  const tags = [...tagCounts(store.tasks).entries()].filter(([t, n]) => !t.includes("/") && n > 0).slice(0, 12);
  return (
    <nav class="sidebar" aria-label="Views">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path d="M16 5v22M5 16h22" stroke="currentColor" stroke-width=".8" opacity=".5" />
          <circle cx="21.5" cy="10.5" r="2.4" fill="currentColor" />
        </svg>
        <span>Ephemeris</span>
      </div>
      <NavItem view="today" icon="today" label="Today" count={todayN} onNav={onNav} />
      <NavItem view="upcoming" icon="upcoming" label="Upcoming" onNav={onNav} />
      <NavItem view="calendar" icon="calendar" label="Calendar" onNav={onNav} />
      <NavItem view="inbox" icon="inbox" label="Inbox" count={inbox(store.tasks).length} onNav={onNav} />
      <NavItem view="unplanned" icon="plan" label="Unplanned" onNav={onNav} />
      <NavItem view="logbook" icon="log" label="Logbook" onNav={onNav} />
      <NavItem view="search" icon="search" label="Find" onNav={onNav} />

      {spaces.map((s) => (
        <div class="nav-group" key={s.id}>
          <NavItem view="space" arg={s.id} icon="space" label={s.name} onNav={onNav} />
          {projects.filter((p) => p.spaceId === s.id).map((p) => (
            <a class={`nav sub ${route.value.view === "project" && route.value.arg === p.id ? "on" : ""}`} href={`#/project/${p.id}`} onClick={onNav}>
              <i class="dot" style={{ background: p.color }} /><span class="nav-label">{p.name}</span>
              {openIn(p.id) ? <span class="nav-count">{openIn(p.id)}</span> : null}
            </a>
          ))}
        </div>
      ))}
      {loose.length > 0 && (
        <div class="nav-group">
          <div class="nav-head">Projects</div>
          {loose.map((p) => (
            <a class={`nav sub ${route.value.view === "project" && route.value.arg === p.id ? "on" : ""}`} href={`#/project/${p.id}`} onClick={onNav}>
              <i class="dot" style={{ background: p.color }} /><span class="nav-label">{p.name}</span>
              {openIn(p.id) ? <span class="nav-count">{openIn(p.id)}</span> : null}
            </a>
          ))}
        </div>
      )}
      <div class="nav-group">
        <NavItem view="tags" icon="tag" label="Tags" onNav={onNav} />
        <div class="nav-tags">
          {tags.map(([t]) => <a href={`#/tag/${encodeURIComponent(t)}`} onClick={onNav}>#{t}</a>)}
        </div>
      </div>
      <div class="nav-foot">
        <NavItem view="settings" icon="gear" label="Settings" onNav={onNav} />
        <button class={`syncdot s-${sync.status}`} onClick={() => void syncNow()} title={sync.error ?? ""}>
          <i />{sync.status === "local" ? "On this device only" : sync.status === "syncing" ? "Syncing" : sync.status === "error" ? "Sync failed" : sync.status === "offline" ? "Offline" : "Synced"}
        </button>
      </div>
    </nav>
  );
}

function Main() {
  const r = useAtom(route);
  switch (r.view) {
    case "upcoming": return <UpcomingView />;
    case "calendar": return <CalendarView />;
    case "inbox": return <InboxView />;
    case "unplanned": return <BacklogView />;
    case "logbook": return <LogbookView />;
    case "project": return r.arg ? <ProjectView id={r.arg} /> : <TodayView />;
    case "space": return r.arg ? <SpaceView id={r.arg} /> : <TodayView />;
    case "tag": return r.arg ? <TagView tag={r.arg} /> : <TagsView />;
    case "tags": return <TagsView />;
    case "search": return <SearchView q={r.arg} />;
    case "settings": return <SettingsView />;
    default: return <TodayView />;
  }
}

function Toast() {
  const t = useAtom(toast);
  if (!t) return null;
  return (
    <div class="toast" role="status">
      <span>{t.text}</span>
      {t.undo && <button class="link-btn" onClick={() => {
        t.undo!();
        toast.set(null);
      }}>Undo</button>}
    </div>
  );
}

function useKeys() {
  useEffect(() => {
    const rows = () => [...document.querySelectorAll<HTMLElement>(".main .row[data-id]")];
    const cursorRow = () => document.querySelector<HTMLElement>(".main .row.is-cursor");
    const setCursor = (el: HTMLElement | undefined) => {
      cursorRow()?.classList.remove("is-cursor");
      if (el) {
        el.classList.add("is-cursor");
        el.scrollIntoView({ block: "nearest" });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key === "a" && rows().length) {
          e.preventDefault();
          rows().forEach((r) => toggleSelect(r.dataset.id!, true));
        }
        return;
      }
      const cur = cursorRow();
      const id = cur?.dataset.id ?? openTask.value ?? undefined;
      const map: Record<string, () => void> = {
        n: () => quickAddFocus.fn ? quickAddFocus.fn() : go("inbox"),
        "/": () => go("search"),
        j: () => {
          const rs = rows();
          setCursor(rs[Math.min(rs.length - 1, cur ? rs.indexOf(cur) + 1 : 0)]);
        },
        k: () => {
          const rs = rows();
          setCursor(rs[Math.max(0, cur ? rs.indexOf(cur) - 1 : 0)]);
        },
        Enter: () => id && openTask.set(id),
        x: () => id && toggleSelect(id),
        d: () => {
          const t = id && store.get<Task>(id);
          if (t && t.status === "open") completeWithUndo(t);
        },
        t: () => {
          const ids = selection.value.size ? [...selection.value] : id ? [id] : [];
          store.batch(() => ids.forEach((i) => updateTask(store, i, { planned: today() })));
        },
        Escape: () => {
          if (selection.value.size || selectMode.value) clearSelection();
          else openTask.set(null);
        },
        "1": () => go("today"),
        "2": () => go("upcoming"),
        "3": () => go("calendar"),
        "4": () => go("inbox"),
        "5": () => go("logbook"),
      };
      const f = map[e.key];
      if (f) {
        e.preventDefault();
        f();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const wide = useAtom(isWide);
  const open = useAtom(openTask);
  const r = useAtom(route);
  const mode = useAtom(selectMode);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  useKeys();
  useEffect(() => setDrawer(false), [r.view, r.arg]);

  return (
    <div class={`app ${wide ? "wide" : "narrow"} ${open ? "has-detail" : ""}`}>
      {wide ? <Sidebar /> : drawer && (
        <div class="drawer-bg" onClick={() => setDrawer(false)}>
          <div class="drawer" onClick={(e) => e.stopPropagation()}><Sidebar onNav={() => setDrawer(false)} /></div>
        </div>
      )}
      <main class="main" id="main">
        {!wide && (
          <div class="mtop">
            <button class="icon-btn" aria-label="Menu" onClick={() => setDrawer(true)}><Icon name="menu" size={20} /></button>
            <span class="mtop-title">Ephemeris</span>
            <span class="mtop-right">
              <button class={`icon-btn ${mode ? "ink-brass" : ""}`} aria-label="Select tasks" aria-pressed={mode}
                onClick={() => (mode ? clearSelection() : selectMode.set(true))}><Icon name="select" size={20} /></button>
              <a class={`icon-btn ${r.view === "settings" ? "ink-brass" : ""}`} href="#/settings" aria-label="Settings"
                aria-current={r.view === "settings" ? "page" : undefined}><Icon name="gear" size={20} /></a>
            </span>
          </div>
        )}
        <Main />
      </main>
      {open && (wide ? <TaskDetail /> : (
        <div class="sheet-bg" onClick={() => openTask.set(null)}>
          <div class="sheet" onClick={(e) => e.stopPropagation()}><TaskDetail /></div>
        </div>
      ))}
      <BulkBar />
      {!wide && (
        <>
          <nav class="tabbar" aria-label="Main views">
            {[
              ["today", "today", "Today"], ["upcoming", "upcoming", "Upcoming"], ["calendar", "calendar", "Calendar"], ["inbox", "inbox", "Inbox"],
            ].map(([v, ic, l]) => (
              <a href={`#/${v}`} class={r.view === v ? "on" : ""} aria-current={r.view === v ? "page" : undefined}><Icon name={ic} size={20} /><span>{l}</span></a>
            ))}
            <button onClick={() => setSheet(true)} class="tab-add" aria-label="New task"><Icon name="plus" size={22} /></button>
          </nav>
          {sheet && (
            <div class="sheet-bg" onClick={() => setSheet(false)}>
              <div class="sheet qa-sheet" onClick={(e) => e.stopPropagation()}>
                <QuickAdd autoFocus defaults={r.view === "today" ? { planned: today() } : r.view === "project" && r.arg ? { projectId: r.arg } : r.view === "tag" && r.arg ? { tags: [r.arg] } : {}} onAdded={() => setSheet(false)} />
              </div>
            </div>
          )}
        </>
      )}
      <Toast />
    </div>
  );
}
