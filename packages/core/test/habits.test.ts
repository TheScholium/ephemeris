import { describe, expect, it } from "vitest";
import {
  Store, memoryPersistence, createHabit, setDone, toggleDone, habitState, streak, habitStats, historyGrid, describeSchedule,
  mergeRec, addDays, holdCheckIn, countOn, addCheckIn, describeHabit, type Habit, type HabitSchedule, type SyncRequest, type SyncResponse, type Rec,
} from "../src";

const T = "2026-10-23"; // Friday
async function mk() {
  const s = new Store(memoryPersistence());
  await s.init();
  return s;
}
async function habit(schedule: HabitSchedule, done: string[], created = "2026-09-01") {
  const s = await mk();
  const h = createHabit(s, "Read", schedule);
  s.update<Habit>(h.id, { createdAt: created + "T12:00:00Z" } as Partial<Habit>);
  (s.get<Habit>(h.id) as any).createdAt = created + "T12:00:00Z";
  for (const d of done) setDone(s, h.id, d, true);
  return { s, h: s.get<Habit>(h.id)! };
}
const days = (from: string, n: number, step = 1) => Array.from({ length: n }, (_, i) => addDays(from, i * step));

describe("habits", () => {
  it("daily: today pending does not break the streak; a missed day does", async () => {
    const { h } = await habit({ type: "daily" }, days("2026-10-18", 5)); // 18..22
    expect(streak(h, T)).toMatchObject({ current: 5, best: 5, unit: "day" });
    expect(habitState(h, T).label).toBe("Due today");
    const { h: h2 } = await habit({ type: "daily" }, ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-19", "2026-10-20"]);
    expect(streak(h2, T)).toMatchObject({ current: 0, best: 3 }); // missed the 21st and 22nd
  });

  it("specific days: rest days neither count nor break", async () => {
    // Mon, Wed, Fri; done Mon 12, Wed 14, Fri 16, Mon 19, Wed 21 -> today Fri 23 pending
    const { h } = await habit({ type: "days", days: [1, 3, 5] }, ["2026-10-12", "2026-10-14", "2026-10-16", "2026-10-19", "2026-10-21"]);
    expect(streak(h, T).current).toBe(5);
    expect(habitState(h, T).due).toBe(true);
    expect(habitState(h, "2026-10-24").label).toBe("Rest day");
    expect(describeSchedule(h.schedule)).toBe("Mon, Wed, Fri");
  });

  it("n times a week counts weeks, and the current week stays open", async () => {
    // week starts Monday. Weeks of Oct 5, 12: 3 each. Week of Oct 19: 2 so far.
    const { h } = await habit({ type: "week", n: 3 }, ["2026-10-05", "2026-10-07", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-17", "2026-10-19", "2026-10-21"]);
    expect(streak(h, T)).toMatchObject({ current: 2, unit: "week" });
    expect(habitState(h, T)).toMatchObject({ progress: { done: 2, target: 3 }, label: "2 of 3 this week", due: true });
    // a week with only 2 breaks it
    const { h: h2 } = await habit({ type: "week", n: 3 }, ["2026-10-05", "2026-10-07", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(streak(h2, T)).toMatchObject({ current: 1, best: 1 });
  });

  it("every other day: gaps up to n keep the streak", async () => {
    const { h } = await habit({ type: "interval", n: 2 }, ["2026-10-15", "2026-10-17", "2026-10-19", "2026-10-21"]);
    expect(streak(h, T)).toMatchObject({ current: 4, unit: "time" });
    expect(habitState(h, T)).toMatchObject({ due: true, label: "Due today" });
    expect(habitState(h, "2026-10-22")).toMatchObject({ due: false, label: "Due tomorrow" });
    expect(streak(h, "2026-10-24").current).toBe(0); // 3 days since the last one
    expect(describeSchedule(h.schedule)).toBe("Every other day");
  });

  it("n times a month", async () => {
    const { h } = await habit({ type: "month", n: 2 }, ["2026-08-03", "2026-08-20", "2026-09-10", "2026-09-11", "2026-10-02"]);
    expect(streak(h, T)).toMatchObject({ current: 2, best: 2, unit: "month" });
    expect(habitState(h, T).label).toBe("1 of 2 this month");
  });

  it("toggle, stats and history grid", async () => {
    const { s, h } = await habit({ type: "daily" }, days("2026-10-09", 14)); // 9..22
    expect(toggleDone(s, h.id, T)).toBe(true);
    const h2 = s.get<Habit>(h.id)!;
    expect(streak(h2, T).current).toBe(15);
    const st = habitStats(h2, T);
    expect(st.total).toBe(15);
    expect(st.rate30).toBeCloseTo(15 / 30);
    const g = historyGrid(h2, T, 4);
    expect(g).toHaveLength(4);
    expect(g[3][4]).toMatchObject({ date: T, done: true, future: false });
    expect(g[3][5].future).toBe(true);
  });

  it("several times a day: a day counts only when the target is met", async () => {
    const s = await mk();
    const h = createHabit(s, "Water", { type: "daily" }, "W", 3);
    expect(describeHabit(h)).toBe("Every day, 3 times a day");
    expect(holdCheckIn(s, h.id, "2026-10-22")).toEqual({ before: 0, after: 1 });
    holdCheckIn(s, h.id, "2026-10-22");
    expect(habitState(s.get<Habit>(h.id)!, "2026-10-22").label).toBe("2 of 3 today");
    expect(streak(s.get<Habit>(h.id)!, "2026-10-22").current).toBe(0); // partial day: not yet
    holdCheckIn(s, h.id, "2026-10-22");
    let x = s.get<Habit>(h.id)!;
    expect(habitState(x, "2026-10-22")).toMatchObject({ doneToday: true, label: "Done today", today: { count: 3, target: 3 } });
    expect(streak(x, "2026-10-22").current).toBe(1);
    // a partial day breaks the streak once it is over
    addCheckIn(s, h.id, "2026-10-23");
    x = s.get<Habit>(h.id)!;
    expect(streak(x, "2026-10-24").current).toBe(0);
    expect(historyGrid(x, "2026-10-23", 1)[0][4]).toMatchObject({ partial: true, done: false });
    // holding a completed day resets it
    expect(holdCheckIn(s, h.id, "2026-10-22")).toEqual({ before: 3, after: 0 });
  });

  it("same-day check-ins from two offline devices add up", async () => {
    const recs = new Map<string, Rec>();
    let seq = 0;
    const seqs = new Map<string, number>();
    const server = async (req: SyncRequest): Promise<SyncResponse> => {
      for (const r of req.changes) {
        const { rec, changed } = mergeRec(recs.get(r.id), r);
        if (changed) { recs.set(r.id, rec); seqs.set(r.id, ++seq); }
      }
      return { seq, changes: [...recs.values()].filter((r) => seqs.get(r.id)! > req.since), more: false };
    };
    const a = await mk();
    const b = await mk();
    const h = createHabit(a, "Water", { type: "daily" }, "W", 8);
    await a.sync(server);
    await b.sync(server);
    addCheckIn(a, h.id, T); addCheckIn(a, h.id, T);
    addCheckIn(b, h.id, T); addCheckIn(b, h.id, T); addCheckIn(b, h.id, T);
    await a.sync(server); await b.sync(server); await a.sync(server);
    expect(countOn(a.get<Habit>(h.id)!, T)).toBe(5);
    expect(countOn(b.get<Habit>(h.id)!, T)).toBe(5);
  });

  it("check-ins made offline on two devices both survive the merge", async () => {
    const recs = new Map<string, Rec>();
    let seq = 0;
    const seqs = new Map<string, number>();
    const server = async (req: SyncRequest): Promise<SyncResponse> => {
      for (const r of req.changes) {
        const { rec, changed } = mergeRec(recs.get(r.id), r);
        if (changed) { recs.set(r.id, rec); seqs.set(r.id, ++seq); }
      }
      return { seq, changes: [...recs.values()].filter((r) => seqs.get(r.id)! > req.since), more: false };
    };
    const a = await mk();
    const b = await mk();
    const h = createHabit(a, "Stretch", { type: "daily" });
    await a.sync(server);
    await b.sync(server);
    setDone(a, h.id, "2026-10-21", true);
    setDone(b, h.id, "2026-10-22", true);
    await a.sync(server);
    await b.sync(server);
    await a.sync(server);
    for (const st of [a, b]) {
      const x = st.get<Habit>(h.id)!;
      expect(countOn(x, "2026-10-21")).toBe(1);
      expect(countOn(x, "2026-10-22")).toBe(1);
    }
  });
});
