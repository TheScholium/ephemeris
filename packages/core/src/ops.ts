// Task operations shared by every client. They take a Store and only call its
// write API, so the same logic runs on the Mac, the iPhone and the Supernote.

import { addDays, diffDays, type ISODate } from "./dates";
import { parseTask, type ParseContext, type Parsed } from "./nlp";
import { nextInstanceDates, normalizeRule } from "./recurrence";
import type { Store } from "./store";
import { randomId, stableId } from "./sync";
import type { Project, Recurrence, Space, Task } from "./types";

const COLORS = ["#c9a45c", "#8fa8c8", "#a8c090", "#c98f8f", "#b49ac8", "#c8b08f", "#8fc8bd", "#c8c48f"];

export function blankTask(init: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: randomId(),
    kind: "task",
    _c: {},
    createdAt: now,
    title: "",
    notes: "",
    status: "open",
    due: null,
    dueTime: null,
    planned: null,
    plannedTime: null,
    estimate: null,
    tags: [],
    projectId: null,
    spaceId: null,
    parentId: null,
    order: Date.now(),
    links: [],
    location: null,
    attachments: [],
    reminders: [],
    recurrence: null,
    seriesId: null,
    occurrence: 1,
    completedAt: null,
    starred: false,
    deleted: false,
    ...init,
  };
}

export function createTask(store: Store, init: Partial<Task>): Task {
  const t = blankTask(init);
  if (t.recurrence) {
    t.recurrence = normalizeRule(t.recurrence);
    t.seriesId = t.seriesId ?? t.id;
  }
  if (t.projectId && !t.spaceId) t.spaceId = store.get<Project>(t.projectId)?.spaceId ?? null;
  return store.insert(t);
}

export function createProject(store: Store, name: string, spaceId: string | null = null): Project {
  const n = store.projects.length;
  return store.insert<Project>({
    id: randomId(), kind: "project", _c: {}, createdAt: new Date().toISOString(),
    name, spaceId, color: COLORS[n % COLORS.length], order: n, archived: false, notes: "", deleted: false,
  });
}

export function createSpace(store: Store, name: string): Space {
  const n = store.spaces.length;
  return store.insert<Space>({
    id: randomId(), kind: "space", _c: {}, createdAt: new Date().toISOString(),
    name, color: COLORS[(n + 3) % COLORS.length], order: n, deleted: false,
  });
}

/** Turn a parse result into task fields, creating the project if it is new. */
export function fieldsFromParsed(store: Store, p: Parsed): Partial<Task> {
  let projectId: string | null = null;
  if (p.project) {
    const found = store.projects.find((x) => x.name.toLowerCase() === p.project!.toLowerCase());
    projectId = (found ?? createProject(store, p.project)).id;
  }
  return {
    title: p.title || "Untitled",
    planned: p.planned,
    plannedTime: p.plannedTime,
    due: p.due,
    dueTime: p.dueTime,
    estimate: p.estimate,
    tags: p.tags,
    projectId,
    recurrence: p.recurrence,
    starred: p.starred,
    reminders: p.reminders.map((r) => ({ id: randomId(8), anchor: r.anchor, offset: r.offset })),
  };
}

export function quickAdd(store: Store, text: string, ctx: ParseContext, extra: Partial<Task> = {}): Task {
  return store.batch(() => {
    const parsed = parseTask(text, ctx, store.projects.map((p) => p.name));
    const f = fieldsFromParsed(store, parsed);
    // Context defaults (e.g. adding inside a project view) apply only where the text is silent.
    const merged: Partial<Task> = { ...extra, ...f };
    if (!f.projectId && extra.projectId) merged.projectId = extra.projectId;
    // a view's default day (e.g. Today) applies only when the text names no date at all:
    // "problem set due mon" typed in Today is a deadline, not a plan for today
    if (!f.planned && !f.due && extra.planned) merged.planned = extra.planned;
    else if (!f.planned) merged.planned = null;
    if (extra.tags?.length) merged.tags = [...new Set([...(extra.tags ?? []), ...(f.tags ?? [])])];
    return createTask(store, merged);
  });
}

export function updateTask(store: Store, id: string, patch: Partial<Task>) {
  const t = store.get<Task>(id);
  if (!t) return;
  const p = { ...patch };
  if (p.recurrence) {
    p.recurrence = normalizeRule(p.recurrence);
    if (!t.seriesId) p.seriesId = t.id;
  }
  if (p.projectId !== undefined && p.spaceId === undefined) {
    p.spaceId = p.projectId ? store.get<Project>(p.projectId)?.spaceId ?? t.spaceId : t.spaceId;
  }
  store.update<Task>(id, p);
}

export function subtasksOf(store: Store, parentId: string): Task[] {
  return store.tasks.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order);
}

export function addSubtask(store: Store, parentId: string, title: string): Task {
  const parent = store.get<Task>(parentId);
  const siblings = subtasksOf(store, parentId);
  return createTask(store, {
    title,
    parentId,
    projectId: parent?.projectId ?? null,
    spaceId: parent?.spaceId ?? null,
    order: (siblings[siblings.length - 1]?.order ?? 0) + 1,
  });
}

/**
 * Mark done. Open subtasks are completed too. A recurring task creates its next
 * instance (with a deterministic id, so two offline devices do not duplicate it).
 * Returns the next instance, if any.
 */
export function completeTask(store: Store, id: string, today: ISODate): Task | null {
  return store.batch(() => {
    const t = store.get<Task>(id);
    if (!t || t.status !== "open") return null;
    const now = new Date().toISOString();
    store.update<Task>(id, { status: "done", completedAt: now });
    for (const s of subtasksOf(store, id)) {
      if (s.status === "open") store.update<Task>(s.id, { status: "done", completedAt: now });
    }
    return t.recurrence ? spawnNext(store, t, today, today) : null;
  });
}

/** Skip this occurrence of a recurring task: drop it and create the next one. */
export function skipOccurrence(store: Store, id: string, today: ISODate): Task | null {
  return store.batch(() => {
    const t = store.get<Task>(id);
    if (!t || !t.recurrence) return null;
    store.update<Task>(id, { status: "dropped", completedAt: new Date().toISOString() });
    return spawnNext(store, t, today, today);
  });
}

export function reopenTask(store: Store, id: string) {
  store.update<Task>(id, { status: "open", completedAt: null });
}

function spawnNext(store: Store, t: Task, doneOn: ISODate, today: ISODate): Task | null {
  const dates = nextInstanceDates(t, doneOn, today);
  if (!dates) return null;
  const series = t.seriesId ?? t.id;
  const occ = (t.occurrence || 1) + 1;
  const nextId = stableId(`${series}:${occ}`);
  const existing = store.get<Task>(nextId);
  if (existing) {
    if (existing.deleted) store.update<Task>(nextId, { deleted: false });
    return existing;
  }
  const anchorOld = t.due ?? t.planned;
  const anchorNew = dates.due ?? dates.planned;
  const delta = anchorOld && anchorNew ? diffDays(anchorNew, anchorOld) : 0;
  const next = store.insert(
    blankTask({
      ...pickCopy(t),
      id: nextId,
      due: dates.due,
      planned: dates.planned,
      seriesId: series,
      occurrence: occ,
    }),
  );
  for (const s of subtasksOf(store, t.id)) {
    store.insert(
      blankTask({
        ...pickCopy(s),
        id: stableId(`${nextId}:${s.id}`),
        parentId: nextId,
        due: s.due ? addDays(s.due, delta) : null,
        planned: s.planned ? addDays(s.planned, delta) : null,
        recurrence: null,
      }),
    );
  }
  return next;
}

function pickCopy(t: Task): Partial<Task> {
  const { title, notes, dueTime, plannedTime, estimate, tags, projectId, spaceId, parentId, order,
    links, location, attachments, reminders, recurrence, starred } = t;
  return { title, notes, dueTime, plannedTime, estimate, tags, projectId, spaceId, parentId, order,
    links, location, attachments, reminders, recurrence, starred };
}

export function deleteTask(store: Store, id: string) {
  store.batch(() => {
    store.update<Task>(id, { deleted: true });
    for (const s of subtasksOf(store, id)) deleteTask(store, s.id);
  });
}

export function restoreTask(store: Store, id: string) {
  store.update<Task>(id, { deleted: false });
}

export function duplicateTask(store: Store, id: string): Task | null {
  const t = store.get<Task>(id);
  if (!t) return null;
  return store.batch(() => {
    const copy = createTask(store, { ...pickCopy(t), title: t.title, recurrence: null, planned: t.planned, due: t.due });
    for (const s of subtasksOf(store, id))
      createTask(store, { ...pickCopy(s), parentId: copy.id, planned: s.planned, due: s.due, recurrence: null });
    return copy;
  });
}

// ---------- bulk edits ----------

export function bulkUpdate(store: Store, ids: string[], patch: Partial<Task>) {
  store.batch(() => ids.forEach((id) => updateTask(store, id, patch)));
}

export function bulkAddTags(store: Store, ids: string[], tags: string[]) {
  store.batch(() => {
    for (const id of ids) {
      const t = store.get<Task>(id);
      if (t) store.update<Task>(id, { tags: [...new Set([...t.tags, ...tags])] });
    }
  });
}

export function bulkRemoveTags(store: Store, ids: string[], tags: string[]) {
  store.batch(() => {
    for (const id of ids) {
      const t = store.get<Task>(id);
      if (t) store.update<Task>(id, { tags: t.tags.filter((x) => !tags.includes(x)) });
    }
  });
}

export function bulkComplete(store: Store, ids: string[], today: ISODate) {
  store.batch(() => ids.forEach((id) => completeTask(store, id, today)));
}

export function bulkDelete(store: Store, ids: string[]) {
  store.batch(() => ids.forEach((id) => deleteTask(store, id)));
}

/** Rename a tag everywhere. Nested tags move too: school -> uni renames school/phys311 -> uni/phys311. */
export function renameTag(store: Store, from: string, to: string) {
  const to2 = to.replace(/^#/, "").trim();
  store.batch(() => {
    for (const t of store.tasks) {
      if (!t.tags.some((x) => x === from || x.startsWith(from + "/"))) continue;
      const tags = t.tags.map((x) => (x === from ? to2 : x.startsWith(from + "/") ? to2 + x.slice(from.length) : x));
      store.update<Task>(t.id, { tags: [...new Set(tags.filter(Boolean))] });
    }
  });
}

export function deleteTag(store: Store, tag: string) {
  renameTag(store, tag, "");
}

export function setRecurrence(store: Store, id: string, rule: Recurrence | null) {
  const t = store.get<Task>(id);
  if (!t) return;
  if (rule) {
    const start = t.due ?? t.planned ?? rule.start;
    const norm = normalizeRule({ ...rule, start });
    const patch: Partial<Task> = { recurrence: norm };
    // an undated task gets the first date of the series as its plan
    if (!t.due && !t.planned) patch.planned = norm.start;
    updateTask(store, id, patch);
  } else {
    store.update<Task>(id, { recurrence: null });
  }
}
