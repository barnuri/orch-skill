import { describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { describeChanges, failedNodes, isLongRunning, LONG_RUNNING_MS, pausedNodes, runningMinutes, snapshotRun } from "./run-attention";

const NOW = Date.parse("2026-11-16T12:00:00Z");

function node(id: string, status: string, extra: Partial<RunNode> = {}): RunNode {
  return { id, status, started: null, error: null, ...extra } as unknown as RunNode;
}

function run(nodes: RunNode[], extra: Partial<RunState> = {}): RunState {
  return { run_id: "r", nodes, ...extra } as unknown as RunState;
}

describe("long-running nodes", () => {
  test("a running node past 20 minutes is long-running, one under is not", () => {
    const old = new Date(NOW - LONG_RUNNING_MS - 1000).toISOString();
    const young = new Date(NOW - 5 * 60000).toISOString();
    expect(isLongRunning(node("a", "running", { started: old }), NOW)).toBe(true);
    expect(isLongRunning(node("b", "running", { started: young }), NOW)).toBe(false);
  });

  test("only running nodes count, and a node without a start time does not", () => {
    const old = new Date(NOW - 60 * 60000).toISOString();
    expect(isLongRunning(node("a", "done", { started: old }), NOW)).toBe(false);
    expect(isLongRunning(node("b", "running", { started: null }), NOW)).toBe(false);
  });

  test("the threshold defaults to 20 minutes and minutes are whole", () => {
    expect(LONG_RUNNING_MS).toBe(20 * 60000);
    expect(runningMinutes(node("a", "running", { started: new Date(NOW - 21.5 * 60000).toISOString() }), NOW)).toBe(21);
  });
});

describe("paused state", () => {
  test("paused nodes are the running nodes of a paused run", () => {
    const nodes = [node("a", "running"), node("b", "done"), node("c", "waiting")];
    expect(pausedNodes(run(nodes, { paused: true }) as RunState).map((n) => n.id)).toEqual(["a"]);
    expect(pausedNodes(run(nodes) as RunState)).toEqual([]);
  });

  test("failed nodes carry their error message", () => {
    const nodes = [node("a", "error", { error: "boom" }), node("b", "done")];
    expect(failedNodes(run(nodes) as RunState)).toEqual([{ id: "a", error: "boom" }]);
  });
});

describe("status change feedback", () => {
  const base = [node("a", "waiting"), node("b", "running")];
  const snap = (nodes: RunNode[], extra: Partial<RunState> = {}) => snapshotRun(run(nodes, extra) as RunState);

  test("the first snapshot reports nothing", () => {
    expect(describeChanges(null, snap(base))).toEqual([]);
  });

  test("a node that starts, finishes or fails is reported", () => {
    const next = [node("a", "running"), node("b", "done")];
    expect(describeChanges(snap(base), snap(next))).toEqual([
      { kind: "ok", text: "a running" },
      { kind: "ok", text: "b done" },
    ]);
    const failed = [node("a", "waiting"), node("b", "error", { error: "exit 2" })];
    expect(describeChanges(snap(base), snap(failed))).toEqual([{ kind: "error", text: "b failed: exit 2" }]);
  });

  test("pause and resume of the run are reported", () => {
    expect(describeChanges(snap(base), snap(base, { paused: true }))).toEqual([{ kind: "ok", text: "Run paused" }]);
    expect(describeChanges(snap(base, { paused: true }), snap(base))).toEqual([{ kind: "ok", text: "Run resumed" }]);
  });

  test("a stopped node that runs again is reported as resumed", () => {
    expect(describeChanges(snap([node("a", "stopped")]), snap([node("a", "running")]))).toEqual([{ kind: "ok", text: "a resumed" }]);
  });

  test("an unchanged run reports nothing", () => {
    expect(describeChanges(snap(base), snap(base))).toEqual([]);
  });
});
