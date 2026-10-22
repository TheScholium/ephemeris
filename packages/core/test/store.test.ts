import { describe, expect, it } from "vitest";
import {
  Store, memoryPersistence, quickAdd, completeTask, skipOccurrence, addSubtask, bulkAddTags, bulkRemoveTags,
  renameTag, todayView, upcoming, filterTasks, tagCounts, taskAlarms, digest, buildICS, parseICS,
  mergeRec, deleteTask, type Rec, type SyncRequest, type SyncResponse, type Task, type Settings,
} from "../src";

const ctx = { today: "2026-10-21", nowMinutes: 12 * 60, weekStart: 1 };

async function newStore() {
  const s = new Store(memoryPersistence());
  await s.init();
  return s;
}

/** Minimal in-memory server with the same semantics as the Worker. */
function fakeServer() {
  const recs = new Map<string, { rec: Rec; seq: number }>();
  let seq = 0;
  return async (req: SyncRequest): Promise<SyncResponse> => {
    for (const r of req.changes) {
      const cur = recs.get(r.id)?.rec;
      const { rec, changed } = mergeRec(cur, r);
      if (changed) recs.set(r.id, { rec, seq: ++seq });
    }
    const changes = [...recs.values()].filter((x) => x.seq > req.since).map((x) => x.rec);
    return { seq, changes, more: false };
  };
}

describe("store, ops and sync", () => {
  it("quick add creates project and tags", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Read Lee ch 3 tomorrow 9am for 90m due fri #drp +Riemannian", ctx);
    expect(t.projectId).toBeTruthy();
    expect(s.projects[0].name).toBe("Riemannian");
    expect(t.due).toBe("2026-10-23");
    expect(t.planned).toBe("2026-10-22");
  });

  it("completing a recurring task spawns exactly one next instance, with subtasks", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Problem set due every fri", ctx);
    addSubtask(s, t.id, "Q1");
    addSubtask(s, t.id, "Q2");
    const next = completeTask(s, t.id, "2026-10-22")!;
    expect(next.due).toBe("2026-10-30");
    expect(next.occurrence).toBe(2);
    const subs = s.tasks.filter((x) => x.parentId === next.id);
    expect(subs.map((x) => x.title)).toEqual(["Q1", "Q2"]);
    expect(subs.every((x) => x.status === "open")).toBe(true);
    // the old subtasks were completed with the parent
    expect(s.tasks.filter((x) => x.parentId === t.id).every((x) => x.status === "done")).toBe(true);
  });

  it("two devices completing the same recurring task offline converge on one next instance", async () => {
    const server = fakeServer();
    const a = await newStore();
    const b = await newStore();
    const t = quickAdd(a, "Laundry every sun", ctx);
    await a.sync(server);
    await b.sync(server);
    completeTask(a, t.id, "2026-10-25");
    completeTask(b, t.id, "2026-10-25");
    await a.sync(server);
    await b.sync(server);
    await a.sync(server);
    const open = (st: Store) => st.tasks.filter((x) => x.title === "Laundry" && x.status === "open");
    expect(open(a)).toHaveLength(1);
    expect(open(b)).toHaveLength(1);
    expect(open(a)[0].id).toBe(open(b)[0].id);
  });

  it("field-level merge keeps both offline edits", async () => {
    const server = fakeServer();
    const a = await newStore();
    const b = await newStore();
    const t = quickAdd(a, "Draft abstract", ctx);
    await a.sync(server);
    await b.sync(server);
    a.update<Task>(t.id, { title: "Draft abstract v2" });
    b.update<Task>(t.id, { due: "2026-11-01" });
    await a.sync(server);
    await b.sync(server);
    await a.sync(server);
    for (const st of [a, b]) {
      const x = st.get<Task>(t.id)!;
      expect(x.title).toBe("Draft abstract v2");
      expect(x.due).toBe("2026-11-01");
    }
  });

  it("default settings never overwrite synced settings", async () => {
    const server = fakeServer();
    const a = await newStore();
    a.update<Settings>("settings", { digestTime: "06:45" });
    await a.sync(server);
    const b = await newStore();
    expect(b.settings.digestTime).toBe("07:30");
    await b.sync(server);
    expect(b.settings.digestTime).toBe("06:45");
  });

  it("skip occurrence drops and advances", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Gym every mon, wed, fri", ctx);
    expect(t.planned).toBe("2026-10-21");
    const n = skipOccurrence(s, t.id, "2026-10-21")!;
    expect(s.get<Task>(t.id)!.status).toBe("dropped");
    expect(n.planned).toBe("2026-10-23");
  });

  it("bulk tag edits and rename with nesting", async () => {
    const s = await newStore();
    const ids = ["a", "b", "c"].map((x) => quickAdd(s, `${x} #school/phys311`, ctx).id);
    bulkAddTags(s, ids.slice(0, 2), ["exam"]);
    bulkRemoveTags(s, [ids[0]], ["school/phys311"]);
    renameTag(s, "school", "unc");
    const tags = ids.map((id) => s.get<Task>(id)!.tags);
    expect(tags).toEqual([["exam"], ["unc/phys311", "exam"], ["unc/phys311"]]);
    expect(filterTasks(s.tasks, { tags: ["unc"] })).toHaveLength(2);
    expect(filterTasks(s.tasks, { tags: ["unc", "exam"], tagMode: "all" })).toHaveLength(1);
    expect([...tagCounts(s.tasks).keys()]).toEqual(["exam", "unc", "unc/phys311"]);
  });

  it("today view separates plan from deadline", async () => {
    const s = await newStore();
    const T = "2026-10-21";
    quickAdd(s, "overdue thing due oct 19", ctx);
    quickAdd(s, "planned now today 2pm for 1h", ctx);
    quickAdd(s, "essay on oct 20 due today", ctx);
    quickAdd(s, "slipped plan on oct 19", ctx);
    quickAdd(s, "needs a plan due oct 24", ctx);
    quickAdd(s, "late plan on oct 27 due oct 24", ctx);
    const v = todayView(s.tasks, T);
    expect(v.overdue.map((t) => t.title)).toEqual(["overdue thing"]);
    expect(v.planned.map((t) => t.title)).toEqual(["planned now"]);
    expect(v.dueToday.map((t) => t.title)).toEqual(["essay"]);
    expect(v.carried.map((t) => t.title)).toEqual(["slipped plan"]);
    expect(v.needsPlan.map((t) => t.title).sort()).toEqual(["late plan", "needs a plan"]);
    expect(v.load).toBe(60);
    const up = upcoming(s.tasks, T, 7);
    const fri = up.find((d) => d.date === "2026-10-24")!;
    expect(fri.deadlines.map((t) => t.title).sort()).toEqual(["late plan", "needs a plan"]);
  });

  it("a view default day does not override a deadline", async () => {
    const s = await newStore();
    expect(quickAdd(s, "Problem set due mon", ctx, { planned: "2026-10-21" }).planned).toBeNull();
    expect(quickAdd(s, "Buy thread", ctx, { planned: "2026-10-21" }).planned).toBe("2026-10-21");
  });

  it("upcoming projects future occurrences of recurring tasks", async () => {
    const s = await newStore();
    quickAdd(s, "Gym every mon, wed, fri for 1h", ctx); // first: Wed Oct 21
    quickAdd(s, "Problem set on oct 21 due every fri", ctx);
    const up = upcoming(s.tasks, "2026-10-22", 10);
    const ghostDays = (title: string, kind: string) =>
      up.flatMap((d) => d.ghosts.filter((g) => g.task.title === title && g.kind === kind).map(() => d.date));
    expect(ghostDays("Gym", "planned")).toEqual(["2026-10-23", "2026-10-26", "2026-10-28", "2026-10-30"]);
    expect(ghostDays("Problem set", "planned")).toEqual(["2026-10-28"]);
    expect(ghostDays("Problem set", "due")).toEqual(["2026-10-30"]);
    expect(up.find((d) => d.date === "2026-10-26")!.load).toBe(60);
  });

  it("deleting a parent deletes subtasks", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Parent", ctx);
    addSubtask(s, t.id, "child");
    deleteTask(s, t.id);
    expect(s.tasks).toHaveLength(0);
  });
});

describe("alarms", () => {
  it("planned time, due offset, evening before", async () => {
    const s = await newStore();
    s.update<Settings>("settings", { tz: "America/New_York" });
    const t = quickAdd(s, "Lab report tomorrow 2pm for 2h due fri 5pm remind 30m before", ctx);
    const al = taskAlarms(t, s.settings).map((a) => [new Date(a.at).toISOString(), a.body]);
    expect(al).toContainEqual(["2026-10-22T17:30:00.000Z", "Planned in 30m · 2h · due Fri Oct 23, 5 PM"]);
    expect(al).toContainEqual(["2026-10-22T18:00:00.000Z", "Now · 2 PM · 2h · due Fri Oct 23, 5 PM"]);
    expect(al).toContainEqual(["2026-10-23T20:00:00.000Z", "Due in 1h · 5 PM"]);
    // planned before the deadline day, so no "due tomorrow" nag
    expect(al.some(([, b]) => b.startsWith("Due tomorrow"))).toBe(false);
  });
  it("digest summarizes the day", async () => {
    const s = await newStore();
    quickAdd(s, "A today 9am for 1h", ctx);
    quickAdd(s, "B due today", ctx);
    quickAdd(s, "C due oct 20", ctx);
    const d = digest(s.tasks, "2026-10-21")!;
    expect(d.title).toBe("Today: 1 planned (1h), 1 due, 1 overdue");
  });
});

describe("ics", () => {
  it("exports and re-imports a planned task", async () => {
    const s = await newStore();
    s.update<Settings>("settings", { tz: "America/New_York" });
    quickAdd(s, "Write DRP notes; part 2, today 3pm for 45m due fri", ctx);
    const ics = buildICS(s.tasks, s.settings);
    expect(ics).toContain("SUMMARY:Write DRP notes\\; part 2");
    expect(ics).toContain("DTSTART:20261021T190000Z");
    const ev = parseICS(ics, "2026-10-19", "2026-10-25", "America/New_York");
    expect(ev.find((e) => e.title.startsWith("Write"))).toMatchObject({ date: "2026-10-21", start: "15:00", duration: 45 });
    expect(ev.find((e) => e.title.startsWith("Due:"))).toMatchObject({ date: "2026-10-23", allDay: true });
  });

  it("expands Google-style recurring events with EXDATE and overrides", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;TZID=America/New_York:20261005T093000",
      "DTEND;TZID=America/New_York:20261005T104500",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261211T235959Z",
      "EXDATE;TZID=America/New_York:20261023T093000",
      "SUMMARY:PHYS 311 Lecture",
      "UID:lec1",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:lec1",
      "RECURRENCE-ID;TZID=America/New_York:20261021T093000",
      "DTSTART;TZID=America/New_York:20261021T130000",
      "DTEND;TZID=America/New_York:20261021T141500",
      "SUMMARY:PHYS 311 Lecture (moved)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const ev = parseICS(ics, "2026-10-19", "2026-10-25", "America/Chicago");
    expect(ev.map((e) => [e.date, e.start, e.title])).toEqual([
      ["2026-10-19", "08:30", "PHYS 311 Lecture"],
      ["2026-10-21", "12:00", "PHYS 311 Lecture (moved)"],
    ]);
  });
});
