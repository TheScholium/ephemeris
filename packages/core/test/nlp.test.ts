import { describe, expect, it } from "vitest";
import { parseTask } from "../src";

// Wednesday, October 21, 2026, 11:24 PM
const ctx = { today: "2026-10-21", nowMinutes: 23 * 60 + 24, weekStart: 1 };
const p = (s: string, projects: string[] = []) => parseTask(s, ctx, projects);

describe("natural language", () => {
  it("separates plan and deadline", () => {
    const r = p("Read Lee ch. 3 tomorrow 9am for 90m due fri #drp +Riemannian");
    expect(r.title).toBe("Read Lee ch. 3");
    expect(r.planned).toBe("2026-10-22");
    expect(r.plannedTime).toBe("09:00");
    expect(r.estimate).toBe(90);
    expect(r.due).toBe("2026-10-23");
    expect(r.tags).toEqual(["drp"]);
    expect(r.project).toBe("Riemannian");
  });

  it("deadline with time, no plan", () => {
    const r = p("PHYS 311 problem set 7 due mon 11:59pm #phys311");
    expect(r.title).toBe("PHYS 311 problem set 7");
    expect(r.due).toBe("2026-10-26");
    expect(r.dueTime).toBe("23:59");
    expect(r.planned).toBeNull();
  });

  it("by / before as deadline keywords", () => {
    expect(p("Submit Capstone application by oct 30").due).toBe("2026-10-30");
    expect(p("Email Dr. Lu before next fri").due).toBe("2026-10-30");
  });

  it("weekday semantics: bare = next one, next = next week's", () => {
    expect(p("x fri").planned).toBe("2026-10-23");
    expect(p("x wednesday").planned).toBe("2026-10-28"); // today is Wed -> next week
    expect(p("x next fri").planned).toBe("2026-10-30");
    expect(p("x this fri").planned).toBe("2026-10-23");
  });

  it("does not read ordinary words as dates", () => {
    expect(p("Read about the sun").planned).toBeNull();
    expect(p("Read the 2nd chapter").planned).toBeNull();
    expect(p("Do problems 3/4 of set").planned).toBeNull();
    expect(p("Plan weekend trip").planned).toBeNull();
    expect(p("Read paper by Witten").due).toBeNull();
    expect(p("Read paper by Witten").title).toBe("Read paper by Witten");
    expect(p("Watch 5 min video").estimate).toBeNull();
  });

  it("ambiguous words parse after keywords", () => {
    expect(p("Laundry on sun").planned).toBe("2026-10-25");
    expect(p("Groceries on sat").planned).toBe("2026-10-24");
    expect(p("Draft solutions sat 2pm").planned).toBe("2026-10-24");
    expect(p("Draft solutions sat 2pm").title).toBe("Draft solutions");
    expect(p("Rent due the 1st").due).toBe("2026-11-01");
    expect(p("Lab report due 11/3").due).toBe("2026-11-03");
  });

  it("dates in many forms", () => {
    expect(p("a oct 28").planned).toBe("2026-10-28");
    expect(p("a october 28th").planned).toBe("2026-10-28");
    expect(p("a 28 oct").planned).toBe("2026-10-28");
    expect(p("a jan 5").planned).toBe("2027-01-05"); // rolls to next year
    expect(p("a 2026-12-01").planned).toBe("2026-12-01");
    expect(p("a in 3 days").planned).toBe("2026-10-24");
    expect(p("a in two weeks").planned).toBe("2026-11-04");
    expect(p("a next week").planned).toBe("2026-10-26");
    expect(p("a next month").planned).toBe("2026-11-01");
    expect(p("a eom").planned).toBe("2026-10-31");
    expect(p("Return books due yesterday").due).toBe("2026-10-20");
    expect(p("a tomorrow evening").plannedTime).toBe("18:00");
    expect(p("a tonight").plannedTime).toBe("20:00");
  });

  it("time only: past time rolls to tomorrow", () => {
    const r = p("Call home at 9am");
    expect(r.planned).toBe("2026-10-22");
    expect(r.plannedTime).toBe("09:00");
    expect(r.title).toBe("Call home");
    const late = parseTask("Stretch 11:45pm", { ...ctx }, []);
    expect(late.planned).toBe("2026-10-21");
  });

  it("time ranges set time and estimate", () => {
    const r = p("Office hours thu 3-5pm");
    expect(r.planned).toBe("2026-10-22");
    expect(r.plannedTime).toBe("15:00");
    expect(r.estimate).toBe(120);
    expect(r.title).toBe("Office hours");
    expect(p("Seminar 11-1pm tomorrow").plannedTime).toBe("11:00");
    expect(p("Seminar 11-1pm tomorrow").estimate).toBe(120);
  });

  it("estimates", () => {
    expect(p("a ~1h30").estimate).toBe(90);
    expect(p("a for 1.5 hours").estimate).toBe(90);
    expect(p("a (45m)").estimate).toBe(45);
    expect(p("a for half an hour").estimate).toBe(30);
    expect(p("a for 2h 15m").estimate).toBe(135);
  });

  it("recurrence", () => {
    const a = p("Daily arXiv skim every weekday at 8am for 20m #arxiv");
    expect(a.recurrence?.freq).toBe("weekly");
    expect(a.recurrence?.byDay).toEqual(["MO", "TU", "WE", "TH", "FR"]);
    expect(a.planned).toBe("2026-10-22"); // 8am today has passed, so the series starts tomorrow
    expect(a.plannedTime).toBe("08:00");
    expect(a.title).toBe("Daily arXiv skim");

    const b = p("Water plants every 3 days after done");
    expect(b.recurrence).toMatchObject({ freq: "daily", interval: 3, mode: "completion" });
    expect(b.title).toBe("Water plants");

    const c = p("Pay rent every month on the 1st");
    expect(c.recurrence).toMatchObject({ freq: "monthly", byMonthDay: [1] });
    expect(c.planned).toBe("2026-11-01");

    const d = p("Problem set due every fri 5pm");
    expect(d.recurrence?.byDay).toEqual(["FR"]);
    expect(d.due).toBe("2026-10-23");
    expect(d.title).toBe("Problem set");

    const e = p("Group meeting every other tue");
    expect(e.recurrence).toMatchObject({ freq: "weekly", interval: 2, byDay: ["TU"] });
    expect(e.planned).toBe("2026-10-27");

    const f = p("Review notes every mon, wed and fri");
    expect(f.recurrence?.byDay).toEqual(["MO", "WE", "FR"]);

    const g = p("Faculty lunch every month on the last fri");
    expect(g.recurrence?.byNthDay).toEqual([{ day: "FR", n: -1 }]);
    expect(g.planned).toBe("2026-10-30");

    const h = p("Birthday card every year on nov 12");
    expect(h.recurrence).toMatchObject({ freq: "yearly", byMonth: [11], byMonthDay: [12] });
    expect(h.planned).toBe("2026-11-12");

    const i = p("Gym daily until dec 15");
    expect(i.recurrence?.until).toBe("2026-12-15");

    const k = p("Read Lee ch. 4 next mon 9am for 2h due next fri every week");
    expect([k.planned, k.due, k.recurrence?.start]).toEqual(["2026-10-26", "2026-10-30", "2026-10-30"]);
    const l = p("Review on next mon every mon due next fri");
    expect(l.recurrence?.byDay).toEqual(["FR"]);
    expect([l.planned, l.due]).toEqual(["2026-10-26", "2026-10-30"]);

    const j = p("Flashcards every 2 days starting nov 1");
    expect(j.recurrence?.interval).toBe(2);
    expect(j.planned).toBe("2026-11-01");
  });

  it("weekday recurrence starts today when today matches", () => {
    expect(p("Skim arXiv every weekday").planned).toBe("2026-10-21");
  });

  it("star, reminders, quotes", () => {
    const r = p("Call registrar tomorrow 10am remind 15m before !");
    expect(r.starred).toBe(true);
    expect(r.reminders).toEqual([{ anchor: "planned", offset: 15 }]);
    const q = p('"Read Sunday Times by Friday" tomorrow');
    expect(q.title).toBe("Read Sunday Times by Friday");
    expect(q.planned).toBe("2026-10-22");
    expect(q.due).toBeNull();
  });

  it("project matching uses known names and underscores", () => {
    expect(p("x +riem", ["Riemannian geometry"]).project).toBe("Riemannian geometry");
    expect(p("x +Vortex_shedding").project).toBe("Vortex shedding");
  });

  it("spans cover parsed tokens", () => {
    const r = p("Read tomorrow #drp");
    expect(r.spans.map((s) => s.kind)).toEqual(["planned", "tag"]);
  });
});
