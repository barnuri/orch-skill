import { test, expect } from "bun:test";
import { newCtx, setStatus } from "../../core/runs/node.ts";
import { markStartedIn } from "../../core/commands/timing.ts";
import { nodeTiming } from "../../../../src/shared/node-timing";

const T0 = Date.parse("2026-11-16T10:00:00Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString().replace(".000Z", "Z");

type Step = ["dispatch" | "start" | "done" | "error" | "retry", number];
interface Row {
  name: string;
  steps: Step[];
  pauses?: [number, number][];
  /** An open pause or stop, from this second. */
  open?: { kind: "paused" | "stopped"; from: number };
  now: number;
  /** Seconds really running, summed over attempts, pauses left out; null when it never started. */
  run: number | null;
  /** Seconds between dispatch and first real activity, summed over attempts. */
  waited: number;
  phase: string;
}

const ROWS: Row[] = [
  { name: "one attempt", steps: [["dispatch", 0], ["start", 30], ["done", 100]], now: 200, run: 70, waited: 30, phase: "ended" },
  { name: "retry after an error sums both attempts", steps: [["dispatch", 0], ["start", 20], ["error", 50], ["retry", 55], ["dispatch", 60], ["start", 90], ["done", 150]], now: 200, run: 30 + 60, waited: 20 + 30, phase: "ended" },
  { name: "stuck starting, then retried: the first attempt never ran", steps: [["dispatch", 0], ["error", 40], ["retry", 45], ["dispatch", 50], ["start", 55], ["done", 100]], now: 200, run: 45, waited: 40 + 5, phase: "ended" },
  { name: "a pause in the middle is not run time", steps: [["dispatch", 0], ["start", 10], ["done", 100]], pauses: [[40, 70]], now: 200, run: 90 - 30, waited: 10, phase: "ended" },
  { name: "a pause during queue time is not waited time", steps: [["dispatch", 0], ["start", 30], ["done", 100]], pauses: [[10, 20]], now: 200, run: 70, waited: 30 - 10, phase: "ended" },
  { name: "a pause between two attempts changes nothing", steps: [["dispatch", 0], ["start", 10], ["error", 40], ["retry", 45], ["dispatch", 100], ["start", 110], ["done", 130]], pauses: [[50, 90]], now: 200, run: 30 + 20, waited: 10 + 10, phase: "ended" },
  { name: "a pause across two attempts counts once, and swallows the second queue time", steps: [["dispatch", 0], ["start", 10], ["error", 60], ["retry", 62], ["dispatch", 64], ["start", 70], ["done", 120]], pauses: [[50, 80]], now: 200, run: (60 - 10 - 10) + (120 - 70 - 10), waited: 10 + 0, phase: "ended" },
  { name: "dispatched, no activity yet", steps: [["dispatch", 0]], now: 25, run: null, waited: 25, phase: "starting" },
  { name: "running, ticks to now", steps: [["dispatch", 0], ["start", 10]], now: 80, run: 70, waited: 10, phase: "running" },
  { name: "an open pause stops the clock", steps: [["dispatch", 0], ["start", 10]], open: { kind: "paused", from: 50 }, now: 80, run: 40, waited: 10, phase: "running" },
  { name: "an open stop stops the clock", steps: [["dispatch", 0], ["start", 10]], open: { kind: "stopped", from: 60 }, now: 100, run: 50, waited: 10, phase: "running" },
];

function play(steps: Step[]): Record<string, any> {
  const run: any = { nodes: [], edges: [] };
  const node: Record<string, any> = { id: "a", label: "A", status: "waiting", attempts: [], created: at(0), updated: at(0) };
  run.nodes.push(node);
  for (const [what, s] of steps) {
    const ctx = newCtx("/nonexistent-home", "r1", { now: at(s) });
    if (what === "dispatch") setStatus(run, "a", "running", "", "", "", "", ctx, true);
    else if (what === "start") markStartedIn(run, ctx, "a", at(s), "test");
    else if (what === "done") setStatus(run, "a", "done", "", "", "", "", ctx);
    else if (what === "error") setStatus(run, "a", "error", "", "boom", "", "", ctx);
    else {
      // What `node retry` does to a node before it dispatches again: status back to waiting, timing left alone.
      node.status = "waiting";
    }
  }
  return node;
}

for (const row of ROWS) {
  test(`P22 ${row.name}`, () => {
    const node = play(row.steps);
    const pauses = (row.pauses ?? []).map(([from, to]) => ({ from: at(from), to: at(to) }));
    const run = { pauses, ...(row.open === undefined ? {} : row.open.kind === "paused" ? { paused: true, paused_at: at(row.open.from) } : { stopped: true, stopped_at: at(row.open.from) }) };
    const t = nodeTiming(node as any, run, T0 + row.now * 1000);
    expect([t.runMs === null ? null : t.runMs / 1000, t.waitedMs / 1000, t.phase]).toEqual([row.run, row.waited, row.phase]);
  });
}

test("P22 a dispatch stamps dispatched_at only; started_at waits for the first real activity", () => {
  const node = play([["dispatch", 0]]);
  expect([node.dispatched_at, node.started_at ?? null, node.seg_open]).toEqual([at(0), null, true]);
  // The legacy `started` stamp is the dispatch time: it must not be what a duration is built from.
  expect(node.started).toBe(at(0));
  const ctx = newCtx("/nonexistent-home", "r1", { now: at(30) });
  const run: any = { nodes: [node] };
  expect(markStartedIn(run, ctx, "a", at(30), "ping")).toBe(true);
  expect(node.started_at).toBe(at(30));
  // A second activity signal does not move it.
  expect(markStartedIn(run, newCtx("/nonexistent-home", "r1", { now: at(60) }), "a", at(60), "ping")).toBe(false);
  expect(node.started_at).toBe(at(30));
});

test("P22 a node that ends without activity keeps queue time as waited and no run time", () => {
  const node = play([["dispatch", 0], ["error", 40]]);
  expect(node.started_at ?? null).toBeNull();
  expect(node.run_segments).toEqual([{ dispatched: at(0), start: null, end: at(40) }]);
  const t = nodeTiming(node as any, {}, T0 + 100_000);
  expect([t.runMs, t.waitedMs]).toEqual([null, 40_000]);
});
