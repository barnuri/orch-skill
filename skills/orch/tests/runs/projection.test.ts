import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, runState, autoCleanup } from "../helpers";
import { blockersOf, buildRunProjection, flagCleared, loadRunProjection, writeFlags, type ProjectionInput } from "../../core/runs/projection.ts";

autoCleanup();

const ENV = { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "0" };

// A pure fixture: no files, no clock. Every rule below is read from this input alone.
const fixture = (): ProjectionInput => ({
  run: {
    run_id: "r1",
    title: "fixture",
    status: "running",
    edges: [["a", "b"]],
    nodes: [
      { id: "a", status: "done" },
      { id: "b", status: "waiting" },
      { id: "c", status: "waiting" },
      { id: "d", status: "waiting", needs_user: "which db?" },
      { id: "e", status: "error", error: "boom" } as never,
      { id: "f", status: "covered", covered_by: "/r1/g" },
      { id: "g", status: "done", result: { verdict: "full" } },
      { id: "h", status: "skipped" },
      { id: "i", status: "running", job_id: null, owner_state: "dead", owner_reason: "pid gone" },
    ],
  },
  requirements: [
    { id: "R1", text: "fast", status: "partly", nodes: ["a"] },
    { id: "R2", text: "docs", status: "not", nodes: ["e"] },
    { id: "R3", text: "done", status: "handled", nodes: ["g"] },
    { id: "R4", text: "dropped", status: "waived", nodes: [] },
  ],
  handoffs: { a: true, g: false, e: false, i: false },
  flags: [
    { run: "r1", node: "c", rule: "stalled", detail: "idle 20 min", at: "2026-11-23T10:00:00Z", status: "waiting" },
    { run: "r1", node: "a", rule: "unverified", detail: "no handoff", at: "2026-11-23T10:00:00Z", status: "done" },
    { run: "other", node: "c", rule: "stalled", detail: "x", at: "2026-11-23T10:00:00Z", status: "waiting" },
  ],
});

test("pure projection: states, buckets, gaps, ready and next actions from one input", () => {
  const p = buildRunProjection(fixture());
  const state = (id: string) => p.nodes.find((n) => n.id === id)!.state;
  expect(state("b")).toBe("ready");
  expect(state("c")).toBe("ready");
  expect(state("d")).toBe("blocked");
  expect([state("e"), state("f"), state("h"), state("i")]).toEqual(["error", "covered", "skipped", "running"]);
  expect(p.ready).toEqual(["b", "c"]);
  expect(p.blocked).toEqual(["d"]);
  expect(p.covered).toEqual(["f"]);
  expect(p.skipped).toEqual(["h"]);
  expect(p.open_requirements).toEqual(["R2"]);
  expect(p.partials).toEqual(["R1"]);
  expect(p.counts.requirements).toMatchObject({ total: 4, open: 1, in_progress: 1, done: 1, skipped: 1, covered: 0 });
  expect(p.handoff_gaps).toEqual([{ node: "g", reason: "missing_handoff" }]);
  expect(p.owners).toEqual([{ node: "i", job_id: null, owner_state: "dead", owner_reason: "pid gone", diagnosis: "dead" }]);
  expect(p.supervisor.flags).toEqual([{ node: "c", rule: "stalled", detail: "idle 20 min", at: "2026-11-23T10:00:00Z" }]);
  expect(p.next_actions.map((a) => a.kind)).toEqual(["answer_question", "fix_error", "record_handoff", "record_result", "close_requirement", "close_requirement", "review_flag", "start_node", "start_node"]);
  expect(p.status).toBe("running");
});

test("pure projection: paused run starts nothing and reports the gate", () => {
  const input = fixture();
  input.run.paused = true;
  const p = buildRunProjection(input);
  expect([p.status, p.raw_status, p.run_gate, p.ready]).toEqual(["paused", "running", "paused", []]);
  expect(p.next_actions[0]).toMatchObject({ kind: "resume_run" });
  expect(p.next_actions.some((a) => a.kind === "start_node")).toBe(false);
  input.run.stopped = true;
  expect(buildRunProjection(input).status).toBe("stopped");
});

test("pure projection: a finished run has nothing ready and nothing next", () => {
  const input = fixture();
  input.run.status = "done";
  const p = buildRunProjection(input);
  expect([p.status, p.ready, p.next_actions]).toEqual(["done", [], []]);
});

test("pure rules: after_all waits for every other node; a cleared unverified flag is dropped", () => {
  const run = { run_id: "r", status: "running", edges: [] as [string, string][], nodes: [{ id: "x", status: "waiting", after_all: true }, { id: "y", status: "running" }, { id: "z", status: "done" }] };
  expect(blockersOf(run, run.nodes[0]!)).toEqual(["y"]);
  expect(blockersOf(run, run.nodes[0]!, (id) => id !== "z")).toEqual(["y", "z"]);
  expect(flagCleared({ rule: "unverified", status: "done" }, { status: "done" }, true)).toBe(true);
  expect(flagCleared({ rule: "unverified", status: "done" }, { status: "done" }, false)).toBe(false);
  expect(flagCleared({ rule: "stalled", status: "running" }, undefined, false)).toBe(true);
});

test("CLI status, the loader and the flag file agree on one projection", async () => {
  const home = seedHome();
  const o = orch(home, ENV);
  const R = o("run", "start", "proj run").out.trim();
  o("node", "add", R, "a", "A");
  o("node", "add", R, "b", "B", "--after", "a");
  o("node", "add", R, "c", "C");
  o("req", "add", R, "ask one", "--node", "a");
  o("req", "add", R, "ask two");

  const before = await loadRunProjection(home, R);
  expect(before!.ready).toEqual(["a", "c"]);
  expect(before!.blocked).toContain("b");
  expect(before!.open_requirements).toEqual(["R1", "R2"]);

  writeFlags(home, [{ run: R, node: "c", rule: "stalled", detail: "idle 20 min", at: "2026-11-23T10:00:00Z", status: "waiting" }]);
  const cli = JSON.parse(o("run", "status", R, "--json").out);
  const loaded = await loadRunProjection(home, R);
  expect(cli.projection).toEqual(loaded);
  expect(cli.projection.supervisor.flags.map((f: { node: string }) => f.node)).toEqual(["c"]);

  const text = o("run", "status", R).out;
  expect(text).toMatch(/^projection: running \(run running\); open requirements: R1,R2;/m);
  expect(text).toMatch(/^next: start a$/m);

  o("run", "pause", R);
  const paused = await loadRunProjection(home, R);
  expect([paused!.status, paused!.ready]).toEqual(["paused", []]);
  expect(JSON.parse(o("run", "status", R, "--json").out).projection).toEqual(paused);
});

test("a node that finishes without a handoff is a handoff gap, then a completed one is not", async () => {
  const home = seedHome();
  const o = orch(home, ENV);
  const R = o("run", "start", "gap run").out.trim();
  o("node", "add", R, "a", "A");
  o("node", "update", R, "a", "running", "--owner", "coordinator");
  o("node", "update", R, "a", "done");
  expect((await loadRunProjection(home, R))!.handoff_gaps).toEqual([{ node: "a", reason: "missing_handoff" }]);
  writeFileSync(join(o("node", "out", R, "a").out.trim(), "handoff.md"), "did it\n");
  expect((await loadRunProjection(home, R))!.handoff_gaps).toEqual([]);
  expect(nodeOf(home, R, "a").status).toBe("done");
  expect(runState(home, R).status).toBe("running");
});

test("an unknown run has no projection", async () => {
  expect(await loadRunProjection(seedHome(), "missing-run")).toBeNull();
});
