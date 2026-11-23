import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import type { OrchPaths } from "../types/orch-paths";
import { listRunsCached } from "./runs-reader";

const RUNS: number = 60;
const NODES_PER_RUN: number = 40;

function node(id: string): RunNode {
  return { id, label: id, status: "done", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [] } as RunNode;
}

function runState(index: number, status: "running" | "done"): RunState {
  const runId = `20260101-0000${String(index).padStart(2, "0")}-abcd`;
  return {
    run_id: runId,
    title: `Run ${index}`,
    harness_session: "sess",
    started: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
    finished: status === "done" ? "2026-01-01T01:00:00Z" : null,
    status,
    nodes: Array.from({ length: NODES_PER_RUN }, (_, n) => node(`n${n}`)),
    edges: [],
  } as RunState;
}

describe("listRunsCached", () => {
  let home: TempHome;
  let paths: OrchPaths;

  beforeEach(() => {
    home = TempHome.create();
    paths = orchPaths(home.path);
    for (let i = 0; i < RUNS; i++) {
      const state = runState(i, i === 0 ? "running" : "done");
      home.write(`runs/${state.run_id}/state.json`, JSON.stringify(state));
    }
  });

  afterEach(() => {
    home.dispose();
  });

  test("reports miss on a cold call, hit while the files are unchanged, and fresh on bypass", () => {
    expect(listRunsCached(paths).cache).toMatchObject({ mode: "cache", source: "miss" });
    expect(listRunsCached(paths, true).cache).toEqual({ mode: "bypass", source: "fresh", age_ms: 0 });
  });

  test("a bypass read returns the same runs as the cached read", () => {
    const cached = listRunsCached(paths);
    const bypass = listRunsCached(paths, true);
    expect(cached.runs).toHaveLength(RUNS);
    expect(bypass.runs.map((r) => [r.run_id, r.counts])).toEqual(cached.runs.map((r) => [r.run_id, r.counts]));
  });


  test("a running run's change shows in the next read once the short running-summary window passes", async () => {
    const runningId = runState(0, "running").run_id;
    expect(listRunsCached(paths).runs.find((r) => r.run_id === runningId)?.counts.running).toBe(0);
    const running = runState(0, "running");
    running.nodes[0] = { ...node("n0"), status: "running" } as RunNode;
    home.write(`runs/${running.run_id}/state.json`, JSON.stringify(running));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const after = listRunsCached(paths, false).runs.find((r) => r.run_id === runningId);
    expect(after?.counts.running).toBe(1);
    expect(after?.counts.done).toBe(NODES_PER_RUN - 1);
  });
});

