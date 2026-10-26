import { describe, expect, it } from "vitest";
import {
  Store, memoryPersistence, quickAdd, addSubtask, completeTask, splitTask, scheduleSubtasks, spreadDates,
  shareEstimate, todayView, unplanned, type Task,
} from "../src";

const ctx = { today: "2026-10-21", nowMinutes: 12 * 60, weekStart: 1 }; // Wednesday

async function newStore() {
  const s = new Store(memoryPersistence());
  await s.init();
  return s;
}

describe("spread and share", () => {
  it("first section on the first day, last on the last day", () => {
    expect(spreadDates(3, { start: "2026-10-21", end: "2026-10-27" })).toEqual(["2026-10-21", "2026-10-24", "2026-10-27"]);
    expect(spreadDates(1, { start: "2026-10-21", end: "2026-10-27" })).toEqual(["2026-10-21"]);
    expect(spreadDates(0, { start: "2026-10-21" })).toEqual([]);
  });
  it("sections share a day when there are more sections than days", () => {
    expect(spreadDates(4, { start: "2026-10-21", end: "2026-10-22" })).toEqual(["2026-10-21", "2026-10-21", "2026-10-22", "2026-10-22"]);
  });
  it("skips weekends, and falls back when only weekend days exist", () => {
    // Fri Oct 23 to Mon Oct 26: Sat and Sun are skipped
    expect(spreadDates(2, { start: "2026-10-23", end: "2026-10-26", skipWeekends: true })).toEqual(["2026-10-23", "2026-10-26"]);
    // Sat Oct 24 to Sun Oct 25 has no work day: use them anyway
    expect(spreadDates(2, { start: "2026-10-24", end: "2026-10-25", skipWeekends: true })).toEqual(["2026-10-24", "2026-10-25"]);
  });
  it("end before start is treated as one day, and a huge span is capped", () => {
    expect(spreadDates(2, { start: "2026-10-21", end: "2026-10-01" })).toEqual(["2026-10-21", "2026-10-21"]);
    const d = spreadDates(2, { start: "2026-10-21", end: "2099-01-01" });
    expect(d[1] <= "2027-10-21").toBe(true);
  });
  it("estimate shares add up to the total", () => {
    expect(shareEstimate(100, 3)).toEqual([34, 33, 33]);
    expect(shareEstimate(null, 2)).toEqual([null, null]);
    expect(shareEstimate(2, 3)).toEqual([1, 1, null]);
  });
});

describe("splitTask", () => {
  it("makes sections with their own dates, and moves the plan off the parent", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Write report due fri for 120m #phys311", ctx);
    s.update<Task>(t.id, { planned: "2026-10-21" });
    const made = splitTask(
      s, t.id,
      [{ title: "Outline" }, { title: "Draft" }, { title: "Edit" }],
      { start: "2026-10-21", end: "2026-10-23" },
    );
    expect(made.map((x) => x.title)).toEqual(["Outline", "Draft", "Edit"]);
    expect(made.map((x) => x.planned)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(made.every((x) => x.due === "2026-10-23" && x.parentId === t.id)).toBe(true);
    expect(made.every((x) => x.tags.includes("phys311"))).toBe(true);
    expect(made.map((x) => x.estimate)).toEqual([40, 40, 40]);
    const parent = s.get<Task>(t.id)!;
    expect(parent.planned).toBeNull();
    expect(parent.due).toBe("2026-10-23");
    expect(parent.estimate).toBe(120);
  });

  it("keeps an explicit date or estimate on a section", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Study due fri", ctx);
    const made = splitTask(
      s, t.id,
      [{ title: "A", planned: "2026-10-22", estimate: 30 }, { title: "B" }],
      { start: "2026-10-21", end: "2026-10-23" },
    );
    expect(made[0].planned).toBe("2026-10-22");
    expect(made[0].estimate).toBe(30);
    expect(made[1].planned).toBe("2026-10-23");
    expect(made[1].estimate).toBeNull();
  });

  it("does nothing for blank titles, a subtask, a closed task, or a missing task", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Task", ctx);
    expect(splitTask(s, t.id, [{ title: "  " }], { start: "2026-10-21" })).toEqual([]);
    const sub = addSubtask(s, t.id, "Sub");
    expect(splitTask(s, sub.id, [{ title: "x" }], { start: "2026-10-21" })).toEqual([]);
    expect(splitTask(s, "nope", [{ title: "x" }], { start: "2026-10-21" })).toEqual([]);
    completeTask(s, t.id, "2026-10-21");
    expect(splitTask(s, t.id, [{ title: "x" }], { start: "2026-10-21" })).toEqual([]);
  });

  it("shows each section on its own day, and the parent is not flagged as unplanned", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Report due fri", ctx);
    expect(todayView(s.tasks, "2026-10-21").needsPlan.map((x) => x.id)).toContain(t.id);
    expect(unplanned(s.tasks).map((x) => x.id)).toContain(t.id);
    splitTask(s, t.id, [{ title: "One" }, { title: "Two" }], { start: "2026-10-21", end: "2026-10-22" });
    const v = todayView(s.tasks, "2026-10-21");
    expect(v.planned.map((x) => x.title)).toEqual(["One"]);
    expect(v.needsPlan.map((x) => x.id)).not.toContain(t.id);
    expect(unplanned(s.tasks).map((x) => x.id)).not.toContain(t.id);
    expect(todayView(s.tasks, "2026-10-22").planned.map((x) => x.title)).toEqual(["Two"]);
  });

  it("appends to existing subtasks in order", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Task", ctx);
    const first = addSubtask(s, t.id, "Existing");
    const made = splitTask(s, t.id, [{ title: "New" }], { start: "2026-10-21" });
    expect(made[0].order).toBeGreaterThan(first.order);
  });

  it("a recurring parent keeps the spacing of the section dates in the next instance", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Problem set due every fri", ctx);
    const made = splitTask(s, t.id, [{ title: "Q1" }, { title: "Q2" }], { start: "2026-10-21", end: "2026-10-22" });
    expect(made.map((x) => x.planned)).toEqual(["2026-10-21", "2026-10-22"]);
    const next = completeTask(s, t.id, "2026-10-23")!;
    expect(next.due).toBe("2026-10-30");
    const subs = s.tasks.filter((x) => x.parentId === next.id).sort((a, b) => a.order - b.order);
    expect(subs.map((x) => x.planned)).toEqual(["2026-10-28", "2026-10-29"]);
  });
});

describe("scheduleSubtasks", () => {
  it("spreads open subtasks and skips finished ones", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Project due mon", ctx);
    const a = addSubtask(s, t.id, "A");
    const b = addSubtask(s, t.id, "B");
    const c = addSubtask(s, t.id, "C");
    completeTask(s, a.id, "2026-10-21");
    const changed = scheduleSubtasks(s, t.id, { start: "2026-10-21", end: "2026-10-26", skipWeekends: true });
    expect(changed.map((x) => x.id)).toEqual([b.id, c.id]);
    expect(s.get<Task>(b.id)!.planned).toBe("2026-10-21");
    expect(s.get<Task>(c.id)!.planned).toBe("2026-10-26");
    expect(s.get<Task>(a.id)!.planned).toBeNull();
  });
  it("leaves the parent plan alone when no subtask is open", async () => {
    const s = await newStore();
    const t = quickAdd(s, "Task today", ctx);
    s.update<Task>(t.id, { planned: "2026-10-21" });
    expect(scheduleSubtasks(s, t.id, { start: "2026-10-22" })).toEqual([]);
    expect(s.get<Task>(t.id)!.planned).toBe("2026-10-21");
  });
});
