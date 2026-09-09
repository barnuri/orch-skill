import { describe, expect, test } from "bun:test";

import type { RunStatus } from "../../../shared/types/run-status";
import type { RunSummary } from "../../../shared/types/run-summary";
import {
  ALL_STATUSES,
  DEFAULT_RUN_FILTERS,
  SHOW_ALL_RUN_FILTERS,
  matchesRunFilters,
  parseRunFilters,
  runFiltersActive,
  type RunFilters,
} from "./run-filters";

const NOW: number = Date.parse("2026-09-09T12:00:00Z");
const HOUR: number = 3_600_000;

function run(status: RunStatus, finishedHoursAgo: number | null, startedHoursAgo = 100): RunSummary {
  return {
    run_id: "20260909-120000-abcd",
    title: "t",
    status,
    started: new Date(NOW - startedHoursAgo * HOUR).toISOString(),
    finished: finishedHoursAgo === null ? null : new Date(NOW - finishedHoursAgo * HOUR).toISOString(),
    harness_session: "",
    counts: { waiting: 0, running: 0, done: 1, error: 0, skipped: 0 },
  };
}

function filters(overrides: Partial<RunFilters> = {}): RunFilters {
  return { ...DEFAULT_RUN_FILTERS, ...overrides };
}

describe("DEFAULT_RUN_FILTERS", () => {
  test("hides runs older than a day and keeps every status", () => {
    expect(DEFAULT_RUN_FILTERS).toEqual({ age: "1d", status: ALL_STATUSES });
  });
});

describe("SHOW_ALL_RUN_FILTERS", () => {
  // The empty-state escape hatch must reveal a run the *default* filters hide, so it cannot
  // just reset to the default.
  test("keeps a run the default filters hide", () => {
    const old = run("done", 100);
    expect(matchesRunFilters(old, DEFAULT_RUN_FILTERS, NOW)).toBe(false);
    expect(matchesRunFilters(old, SHOW_ALL_RUN_FILTERS, NOW)).toBe(true);
  });

  test("it is a real widening, not the default", () => {
    expect(SHOW_ALL_RUN_FILTERS).not.toEqual(DEFAULT_RUN_FILTERS);
    expect(runFiltersActive(SHOW_ALL_RUN_FILTERS)).toBe(true);
  });
});

describe("matchesRunFilters age", () => {
  test("a run finished inside the window is kept", () => {
    expect(matchesRunFilters(run("done", 5), filters(), NOW)).toBe(true);
  });

  test("a run finished outside the window is hidden", () => {
    expect(matchesRunFilters(run("done", 30), filters(), NOW)).toBe(false);
  });

  test("exactly at the cutoff is still kept", () => {
    expect(matchesRunFilters(run("done", 24), filters(), NOW)).toBe(true);
  });

  // A week-long run must not vanish from the list just because it is slow.
  test("a running run is never aged out", () => {
    expect(matchesRunFilters(run("running", null, 200), filters(), NOW)).toBe(true);
  });

  test("age falls back to `started` when `finished` is null", () => {
    expect(matchesRunFilters(run("error", null, 200), filters(), NOW)).toBe(false);
    expect(matchesRunFilters(run("error", null, 2), filters(), NOW)).toBe(true);
  });

  test("`all` keeps an ancient run", () => {
    expect(matchesRunFilters(run("done", 5000), filters({ age: "all" }), NOW)).toBe(true);
  });

  test("wider windows keep what 1d hides", () => {
    const old = run("done", 100);
    expect(matchesRunFilters(old, filters({ age: "7d" }), NOW)).toBe(true);
    expect(matchesRunFilters(old, filters({ age: "30d" }), NOW)).toBe(true);
  });

  // Hiding a run because its timestamp is unreadable would lose it silently.
  test("an unparseable timestamp keeps the run", () => {
    const broken = { ...run("done", 5), finished: "not-a-date" };
    expect(matchesRunFilters(broken, filters(), NOW)).toBe(true);
  });
});

describe("matchesRunFilters status", () => {
  test("`all` keeps every status", () => {
    for (const status of ["running", "done", "error"] as const) {
      expect(matchesRunFilters(run(status, 1), filters(), NOW)).toBe(true);
    }
  });

  test("a named status keeps only that status", () => {
    expect(matchesRunFilters(run("error", 1), filters({ status: "error" }), NOW)).toBe(true);
    expect(matchesRunFilters(run("done", 1), filters({ status: "error" }), NOW)).toBe(false);
  });

  // Status wins over the running-run age exemption.
  test("a running run is still excluded by a non-matching status", () => {
    expect(matchesRunFilters(run("running", null), filters({ status: "done" }), NOW)).toBe(false);
  });
});

describe("runFiltersActive", () => {
  test("the default is not active", () => {
    expect(runFiltersActive(filters())).toBe(false);
  });

  test("either field diverging makes it active", () => {
    expect(runFiltersActive(filters({ age: "all" }))).toBe(true);
    expect(runFiltersActive(filters({ status: "done" }))).toBe(true);
  });
});

describe("parseRunFilters", () => {
  test("a missing entry is the default", () => {
    expect(parseRunFilters(null)).toEqual(DEFAULT_RUN_FILTERS);
  });

  test("a round trip is preserved", () => {
    const stored = filters({ age: "30d", status: "error" });
    expect(parseRunFilters(JSON.stringify(stored))).toEqual(stored);
  });

  // Stored JSON is user-editable and survives across versions, so each field falls back alone.
  test("unknown values fall back field by field", () => {
    expect(parseRunFilters('{"age":"99d","status":"error"}')).toEqual(
      filters({ status: "error" }),
    );
    expect(parseRunFilters('{"age":"7d","status":"nope"}')).toEqual(filters({ age: "7d" }));
  });

  test("malformed or non-object JSON is the default", () => {
    expect(parseRunFilters("{ not json")).toEqual(DEFAULT_RUN_FILTERS);
    expect(parseRunFilters("null")).toEqual(DEFAULT_RUN_FILTERS);
    expect(parseRunFilters("[]")).toEqual(filters());
  });
});
