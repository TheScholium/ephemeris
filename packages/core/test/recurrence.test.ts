import { describe, expect, it } from "vitest";
import { between, describeRule, nextInstanceDates, normalizeRule, type Recurrence } from "../src";

const R = (r: Partial<Recurrence>): Recurrence => ({ freq: "daily", interval: 1, mode: "schedule", start: "2026-10-21", ...r });

describe("recurrence", () => {
  it("daily / every 3 days", () => {
    expect(between(R({ interval: 3 }), "2026-10-21", "2026-10-31")).toEqual(["2026-10-21", "2026-10-24", "2026-10-27", "2026-10-30"]);
  });
  it("weekly on Mon/Wed/Fri, and every other week keeps phase", () => {
    expect(between(R({ freq: "weekly", byDay: ["MO", "WE", "FR"] }), "2026-10-21", "2026-10-28"))
      .toEqual(["2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28"]);
    const biweekly = R({ freq: "weekly", interval: 2, byDay: ["TU"], start: "2026-10-20" });
    expect(between(biweekly, "2026-10-21", "2026-11-30")).toEqual(["2026-11-03", "2026-11-17"]);
  });
  it("monthly: day 31 clamps, last day, nth weekday", () => {
    expect(between(R({ freq: "monthly", start: "2026-01-31" }), "2026-01-01", "2026-04-30"))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(between(R({ freq: "monthly", byMonthDay: [-1], start: "2026-10-01" }), "2026-10-01", "2026-12-31"))
      .toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(between(R({ freq: "monthly", byNthDay: [{ day: "FR", n: -1 }], start: "2026-10-01" }), "2026-10-01", "2026-12-31"))
      .toEqual(["2026-10-30", "2026-11-27", "2026-12-25"]);
    expect(between(R({ freq: "monthly", byNthDay: [{ day: "TU", n: 2 }], start: "2026-10-01" }), "2026-10-01", "2026-11-30"))
      .toEqual(["2026-10-13", "2026-11-10"]);
  });
  it("yearly: Thanksgiving (4th Thu of Nov)", () => {
    const r = R({ freq: "yearly", byMonth: [11], byNthDay: [{ day: "TH", n: 4 }], start: "2026-01-01" });
    expect(between(r, "2026-01-01", "2028-12-31")).toEqual(["2026-11-26", "2027-11-25", "2028-11-23"]);
  });
  it("count and until", () => {
    expect(between(R({ count: 3 }), "2026-10-21", "2026-12-31")).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(between(R({ until: "2026-10-23" }), "2026-10-21", "2026-12-31")).toHaveLength(3);
  });
  it("normalize moves start to first match", () => {
    expect(normalizeRule(R({ freq: "weekly", byDay: ["MO", "TH"], start: "2026-10-20" })).start).toBe("2026-10-22");
  });
  it("next instance keeps planned offset from due and skips missed dates", () => {
    const rule = R({ freq: "weekly", byDay: ["FR"], start: "2026-10-23" });
    const t = { due: "2026-10-23", planned: "2026-10-21", recurrence: rule, occurrence: 1 };
    expect(nextInstanceDates(t, "2026-10-22", "2026-10-22")).toEqual({ due: "2026-10-30", planned: "2026-10-28" });
    // completed 2 weeks late: next is the first Friday >= today, not a backlog
    expect(nextInstanceDates(t, "2026-11-11", "2026-11-11")).toEqual({ due: "2026-11-13", planned: "2026-11-11" });
  });
  it("after-completion mode counts from the done day", () => {
    const t = { due: null, planned: "2026-10-21", recurrence: R({ interval: 3, mode: "completion" }), occurrence: 1 };
    expect(nextInstanceDates(t, "2026-10-25", "2026-10-25")).toEqual({ due: null, planned: "2026-10-28" });
  });
  it("count ends the series", () => {
    const t = { due: null, planned: "2026-10-22", recurrence: R({ count: 2 }), occurrence: 2 };
    expect(nextInstanceDates(t, "2026-10-22", "2026-10-22")).toBeNull();
  });
  it("describes", () => {
    expect(describeRule(R({ freq: "weekly", byDay: ["MO", "WE", "FR"] }))).toBe("Every week on Mon, Wed, Fri");
    expect(describeRule(R({ freq: "weekly", byDay: ["MO", "TU", "WE", "TH", "FR"] }))).toBe("Every weekday");
    expect(describeRule(R({ freq: "monthly", byNthDay: [{ day: "FR", n: -1 }] }))).toBe("Every month on the last Fri");
    expect(describeRule(R({ interval: 3, mode: "completion" }))).toBe("Every 3 days after completion");
    expect(describeRule(R({ freq: "weekly", interval: 2, start: "2026-10-20" }))).toBe("Every other week on Tue");
  });
});
