import { describe, expect, test } from "bun:test";

import { hasTiming, isStarting, nodeTiming, pauseSpans, timingSummary } from "./node-timing";
import type { TimedNode } from "./node-timing";

const T0 = Date.parse("2026-11-15T10:00:00Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const now = (s: number): number => T0 + s * 1000;

describe("pauseSpans", () => {
  test("no run gives no spans", () => {
    expect(pauseSpans(null, now(10))).toEqual([]);
    expect(pauseSpans(undefined, now(10))).toEqual([]);
  });
  test("closed pauses, an unclosed pause entry ends now", () => {
    const spans = pauseSpans({ pauses: [{ from: at(10), to: at(20) }, { from: at(30), to: null }] }, now(40));
    expect(spans).toEqual([
      [now(10), now(20)],
      [now(30), now(40)],
    ]);
  });
  test("an open pause or stop ends now", () => {
    expect(pauseSpans({ paused: true, paused_at: at(5) }, now(15))).toEqual([[now(5), now(15)]]);
    expect(pauseSpans({ stopped: true, stopped_at: at(7) }, now(15))).toEqual([[now(7), now(15)]]);
  });
  test("bad or empty spans are dropped", () => {
    expect(pauseSpans({ pauses: [{ from: "bad", to: at(1) }, { from: at(5), to: at(5) }] }, now(10))).toEqual([]);
  });
});

describe("hasTiming and isStarting", () => {
  test("legacy nodes have no timing", () => {
    expect(hasTiming({ status: "done", started: at(0) })).toBe(false);
    expect(hasTiming({ status: "running", dispatched_at: at(0) })).toBe(true);
    expect(hasTiming({ status: "running", seg_open: false })).toBe(true);
    expect(hasTiming({ status: "done", run_segments: [] })).toBe(true);
  });
  test("starting means running, open segment, no real start", () => {
    expect(isStarting({ status: "running", seg_open: true, dispatched_at: at(0) })).toBe(true);
    expect(isStarting({ status: "running", seg_open: true, started_at: at(1) })).toBe(false);
    expect(isStarting({ status: "done", seg_open: true })).toBe(false);
    expect(isStarting({ status: "running", seg_open: false })).toBe(false);
  });
});

describe("nodeTiming", () => {
  test("legacy fallback uses started and finished", () => {
    const done = nodeTiming({ status: "done", started: at(0), finished: at(65) }, null, now(100));
    expect(done).toMatchObject({ known: false, phase: "ended", runMs: 65_000, waitedMs: 0, liveSince: null });
    const live = nodeTiming({ status: "running", started: at(0) }, null, now(30));
    expect(live).toMatchObject({ known: false, phase: "running", runMs: 30_000, liveSince: at(0) });
    expect(nodeTiming({ status: "waiting" }, null, now(5))).toMatchObject({ phase: "waiting", runMs: null });
  });
  test("legacy fallback leaves pauses out", () => {
    const t = nodeTiming({ status: "done", started: at(0), finished: at(60) }, { pauses: [{ from: at(10), to: at(30) }] }, now(100));
    expect(t.runMs).toBe(40_000);
  });
  test("segments are summed with queue time as waited", () => {
    const node: TimedNode = {
      status: "done",
      dispatched_at: at(100),
      started_at: at(110),
      finished_at: at(150),
      seg_open: false,
      run_segments: [
        { dispatched: at(0), start: at(5), end: at(25) },
        { dispatched: at(40), start: null, end: at(50) },
      ],
    };
    const t = nodeTiming(node, null, now(200));
    expect(t).toMatchObject({ known: true, phase: "ended", runMs: 20_000, waitedMs: 15_000, liveSince: null });
  });
  test("open segment ticks from started_at, pause subtracted", () => {
    const node: TimedNode = { status: "running", dispatched_at: at(0), started_at: at(10), seg_open: true, run_segments: [] };
    const t = nodeTiming(node, { pauses: [{ from: at(20), to: at(30) }] }, now(60));
    expect(t).toMatchObject({ phase: "running", runMs: 40_000, waitedMs: 10_000, liveSince: at(10), waitingSince: null });
  });
  test("an open run pause stops the clock", () => {
    const node: TimedNode = { status: "running", dispatched_at: at(0), started_at: at(0), seg_open: true };
    expect(nodeTiming(node, { paused: true, paused_at: at(30) }, now(90)).runMs).toBe(30_000);
  });
  test("starting phase: dispatched, no real activity yet", () => {
    const node: TimedNode = { status: "running", dispatched_at: at(0), started_at: null, seg_open: true };
    const t = nodeTiming(node, null, now(12));
    expect(t).toMatchObject({ phase: "starting", runMs: null, waitedMs: 12_000, liveSince: null, waitingSince: at(0) });
  });
});

describe("timingSummary", () => {
  test("rounds down to seconds", () => {
    const node: TimedNode = { status: "running", dispatched_at: at(0), started_at: at(2.5), seg_open: true };
    expect(timingSummary(node, null, now(10.9))).toEqual({ phase: "running", run_s: 8, waited_s: 2 });
    expect(timingSummary({ status: "waiting" }, null, now(5))).toEqual({ phase: "waiting", run_s: null, waited_s: 0 });
  });
});
