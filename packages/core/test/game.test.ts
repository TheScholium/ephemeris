import { describe, expect, it } from "vitest";
import {
  Store, memoryPersistence, mergeRec, completeTask, reopenTask, createTask, createHabit, addCheckIn, setCount,
  setTagTraits, traitsOfTask, levelFromXp, xpForLevel, taskXp, characterSheet, renderSheetText, traitTotals,
  type Rec, type SyncRequest, type SyncResponse, type Settings,
} from "../src";

const TODAY = "2026-10-24";

async function newStore() {
  const s = new Store(memoryPersistence());
  await s.init();
  return s;
}

function fakeServer() {
  const recs = new Map<string, { rec: Rec; seq: number }>();
  let seq = 0;
  return async (req: SyncRequest): Promise<SyncResponse> => {
    for (const r of req.changes) {
      const { rec, changed } = mergeRec(recs.get(r.id)?.rec, r);
      if (changed) recs.set(r.id, { rec, seq: ++seq });
    }
    return { seq, changes: [...recs.values()].filter((x) => x.seq > req.since).map((x) => x.rec), more: false };
  };
}

describe("level curve", () => {
  it("matches the formula and inverts it", () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(1)).toBe(50);
    expect(xpForLevel(10)).toBe(1582);
    for (const n of [1, 2, 5, 10, 33, 50, 100]) {
      expect(levelFromXp(xpForLevel(n))).toBe(n);
      expect(levelFromXp(xpForLevel(n) - 1)).toBe(n - 1);
    }
    expect(levelFromXp(0)).toBe(0);
    expect(levelFromXp(49)).toBe(0);
  });
  it("values tasks by estimate, within bounds", () => {
    expect(taskXp({ estimate: null })).toBe(10);
    expect(taskXp({ estimate: 2 })).toBe(5);
    expect(taskXp({ estimate: 60 })).toBe(10);
    expect(taskXp({ estimate: 600 })).toBe(30);
  });
});

describe("traits of a task", () => {
  it("defaults to presentation, uses explicit traits, and adds tag traits", async () => {
    const s = await newStore();
    expect(traitsOfTask({ traits: [], tags: [] }, s.settings)).toEqual(["presentation"]);
    expect(traitsOfTask({ traits: ["peace"], tags: [] }, s.settings)).toEqual(["peace"]);
    setTagTraits(s, "#Phys311", ["wisdom"]);
    expect(traitsOfTask({ traits: [], tags: ["phys311"] }, s.settings)).toEqual(["wisdom"]);
    expect(traitsOfTask({ traits: ["peace"], tags: ["Phys311"] }, s.settings)).toEqual(["peace", "wisdom"]);
    setTagTraits(s, "phys311", []);
    expect(traitsOfTask({ traits: [], tags: ["phys311"] }, s.settings)).toEqual(["presentation"]);
  });
  it("tolerates old records with no traits field", async () => {
    const s = await newStore();
    expect(traitsOfTask({ tags: [] } as any, s.settings)).toEqual(["presentation"]);
  });
});

describe("experience from tasks", () => {
  it("grants experience to each trait on completion", async () => {
    const s = await newStore();
    setTagTraits(s, "phys311", ["wisdom"]);
    const t = createTask(s, { title: "Griffiths 5.3", tags: ["phys311"], traits: ["peace"], estimate: 60 });
    completeTask(s, t.id, TODAY);
    const totals = traitTotals(s.events);
    expect(totals.wisdom).toBe(10);
    expect(totals.peace).toBe(10);
    expect(totals.presentation).toBe(0);
  });
  it("removes experience on reopen and does not duplicate it on completing again", async () => {
    const s = await newStore();
    const t = createTask(s, { title: "Wash face" });
    completeTask(s, t.id, TODAY);
    expect(traitTotals(s.events).presentation).toBe(10);
    reopenTask(s, t.id);
    expect(traitTotals(s.events).presentation).toBe(0);
    completeTask(s, t.id, TODAY);
    completeTask(s, t.id, TODAY);
    reopenTask(s, t.id);
    completeTask(s, t.id, TODAY);
    expect(traitTotals(s.events).presentation).toBe(10);
    expect(s.events.length).toBe(1);
  });
  it("two devices completing the same task offline keep one set of events", async () => {
    const server = fakeServer();
    const a = await newStore();
    const b = await newStore();
    const t = createTask(a, { title: "Laundry" });
    await a.sync(server);
    await b.sync(server);
    completeTask(a, t.id, TODAY);
    completeTask(b, t.id, TODAY);
    await a.sync(server);
    await b.sync(server);
    await a.sync(server);
    expect(a.events.length).toBe(1);
    expect(b.events.length).toBe(1);
    expect(traitTotals(a.events).presentation).toBe(10);
  });
});

describe("experience from rituals", () => {
  it("grants experience per check-in and revokes when the day is cleared", async () => {
    const s = await newStore();
    const h = createHabit(s, "Stretch");
    s.update<any>(h.id, { traits: ["constitution", "peace"] });
    addCheckIn(s, h.id, TODAY);
    addCheckIn(s, h.id, TODAY);
    expect(traitTotals(s.events).constitution).toBe(10);
    expect(traitTotals(s.events).peace).toBe(10);
    setCount(s, h.id, TODAY, 0);
    expect(traitTotals(s.events).constitution).toBe(0);
    setCount(s, h.id, TODAY, 2);
    expect(traitTotals(s.events).constitution).toBe(10);
  });
  it("check-ins from two devices on the same day both count", async () => {
    const server = fakeServer();
    const a = await newStore();
    const b = await newStore();
    const h = createHabit(a, "Water");
    await a.sync(server);
    await b.sync(server);
    addCheckIn(a, h.id, TODAY);
    addCheckIn(b, h.id, TODAY);
    await a.sync(server);
    await b.sync(server);
    await a.sync(server);
    expect(a.events.length).toBe(2);
    expect(traitTotals(a.events).presentation).toBe(10);
  });
});

describe("character sheet", () => {
  it("summarizes levels, progress and recent work", async () => {
    const s = await newStore();
    const t = createTask(s, { title: "Read chapter", traits: ["wisdom"], estimate: 180 });
    completeTask(s, t.id, TODAY);
    const sheet = characterSheet(s, TODAY);
    const w = sheet.traits.find((x) => x.trait === "wisdom")!;
    expect(w.xp).toBe(30);
    expect(w.level).toBe(0);
    expect(w.frac).toBeCloseTo(30 / 50);
    expect(sheet.recent).toHaveLength(1);
    expect(sheet.recent[0].label).toBe("Read chapter");
    const text = renderSheetText(sheet);
    expect(text).toContain("Wisdom");
    expect(text).toContain("Read chapter");
  });
  it("ignores events outside the window in the recent list but keeps them in totals", async () => {
    const s = await newStore();
    const t = createTask(s, { title: "Old", traits: ["charisma"] });
    completeTask(s, t.id, TODAY);
    const sheet = characterSheet(s, "2026-11-30");
    expect(sheet.recent).toHaveLength(0);
    expect(sheet.traits.find((x) => x.trait === "charisma")!.xp).toBe(10);
  });
});

// keeps the unused-import check quiet if Settings changes
void (null as unknown as Settings);
