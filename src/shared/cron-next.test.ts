import { describe, expect, test } from "bun:test";

import { cronNextIn, nextRuns, validZone } from "./cron-next";

const iso = (s: number | null): string => (s === null ? "none" : new Date(s * 1000).toISOString());

describe("cronNextIn with a time zone", () => {
  test("reads the cron in the zone, not in UTC", () => {
    expect(iso(cronNextIn("0 9 * * *", Date.parse("2026-06-01T00:00:00Z") / 1000, "Asia/Jerusalem"))).toBe("2026-06-01T06:00:00.000Z");
    expect(iso(cronNextIn("0 9 * * *", Date.parse("2026-06-01T00:00:00Z") / 1000, "America/New_York"))).toBe("2026-06-01T13:00:00.000Z");
  });

  test("09:00 stays 09:00 local across the spring-forward day", () => {
    const runs = nextRuns("0 9 * * *", Date.parse("2026-03-07T12:00:00Z") / 1000, 3, "America/New_York").map(iso);
    expect(runs).toEqual(["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
  });

  test("a wall-clock time that does not exist is skipped, one that happens twice fires once", () => {
    expect(iso(cronNextIn("30 2 * * *", Date.parse("2026-03-08T00:00:00Z") / 1000, "America/New_York"))).toBe("2026-03-09T06:30:00.000Z");
    const runs = nextRuns("30 1 * * *", Date.parse("2026-11-01T00:00:00Z") / 1000, 2, "America/New_York").map(iso);
    expect(runs).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });

  test("weekday and day-of-month rules, bad input, zones", () => {
    expect(iso(cronNextIn("0 9 * * 1-5", Date.parse("2026-11-14T00:00:00Z") / 1000, "UTC"))).toBe("2026-11-16T09:00:00.000Z");
    expect(cronNextIn("61 * * * *", 0, "UTC")).toBeNull();
    expect(cronNextIn("0 0 31 2 *", 0, "UTC")).toBeNull();
    expect(validZone("Asia/Jerusalem")).toBe(true);
    expect(validZone("Mars/Base")).toBe(false);
  });

  test("local time when no zone is given", () => {
    const next = cronNextIn("*/5 * * * *", 1_800_000_001);
    expect(next).toBe(1_800_000_300);
    expect((next as number) % 300).toBe(0);
  });
});
