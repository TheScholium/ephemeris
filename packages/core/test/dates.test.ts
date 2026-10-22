import { describe, expect, it } from "vitest";
import { addMonths, epochToZoned, relDate, startOfWeek, weekday, zonedToEpoch, fmtDuration } from "../src";

describe("dates", () => {
  it("weekday and week start", () => {
    expect(weekday("2026-10-21")).toBe(3); // Wednesday
    expect(startOfWeek("2026-10-21", 1)).toBe("2026-10-19");
    expect(startOfWeek("2026-10-21", 0)).toBe("2026-10-18");
  });
  it("addMonths clamps", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
  it("time zone round trip incl. DST", () => {
    const tz = "America/New_York";
    const t = zonedToEpoch("2026-10-21", "09:00", tz);
    expect(new Date(t).toISOString()).toBe("2026-10-21T13:00:00.000Z");
    expect(epochToZoned(t, tz)).toEqual({ date: "2026-10-21", time: "09:00" });
    // after fall-back (Nov 1 2026) EST = UTC-5
    expect(new Date(zonedToEpoch("2026-11-02", "09:00", tz)).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // spring-forward gap 2:30 does not exist; moves forward to 3:30 EDT
    expect(new Date(zonedToEpoch("2027-03-14", "02:30", tz)).toISOString()).toBe("2027-03-14T07:30:00.000Z");
  });
  it("relative labels", () => {
    expect(relDate("2026-10-21", "2026-10-21")).toBe("Today");
    expect(relDate("2026-10-23", "2026-10-21")).toBe("Fri");
    expect(relDate("2026-11-02", "2026-10-21")).toBe("Nov 2");
    expect(relDate("2027-01-04", "2026-10-21")).toBe("Jan 4, 2027");
    expect(fmtDuration(95)).toBe("1h 35m");
  });
});
