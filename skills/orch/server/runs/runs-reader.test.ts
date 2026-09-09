import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";
import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import type { OrchPaths } from "../types/orch-paths";
import { isRunId } from "./run-id";
import { listRuns, readRun } from "./runs-reader";

const MAX_ID_LENGTH: number = 128;

function node(id: string, status: string): RunNode {
  return {
    id,
    label: id,
    // Fixtures deliberately include a status the type does not know about.
    status: status as RunNode["status"],
    profile: null,
    adapter: null,
    job_id: null,
    started: null,
    finished: null,
    error: null,
    log_tail: [],
  };
}

function runState(runId: string, started: string, nodes: RunNode[]): RunState {
  return {
    run_id: runId,
    title: `Run ${runId}`,
    harness_session: "sess-1",
    started,
    finished: null,
    status: "running",
    nodes,
    edges: [],
  };
}

function writeRun(home: TempHome, state: RunState): void {
  home.write(`runs/${state.run_id}/state.json`, JSON.stringify(state));
}

describe("isRunId", () => {
  test("accepts the CLI's generated ids and plain custom ids", () => {
    expect(isRunId("20260902-193000-a1b2")).toBe(true);
    expect(isRunId("a")).toBe(true);
    expect(isRunId("my.run_v2-final")).toBe(true);
    expect(isRunId("a".repeat(MAX_ID_LENGTH))).toBe(true);
  });

  test("rejects empty, dot-leading, separator-bearing and over-long ids", () => {
    expect(isRunId("")).toBe(false);
    expect(isRunId(".")).toBe(false);
    expect(isRunId("..")).toBe(false);
    expect(isRunId(".hidden")).toBe(false);
    expect(isRunId("-dash-first")).toBe(false);
    expect(isRunId("a/b")).toBe(false);
    expect(isRunId("../profiles.json")).toBe(false);
    expect(isRunId("a b")).toBe(false);
    expect(isRunId("rün")).toBe(false);
    expect(isRunId("a".repeat(MAX_ID_LENGTH + 1))).toBe(false);
  });
});

describe("listRuns", () => {
  let home: TempHome;
  let paths: OrchPaths;

  beforeEach(() => {
    home = TempHome.create();
    paths = orchPaths(home.path);
  });

  afterEach(() => {
    home.dispose();
  });

  test("empty runs directory lists nothing", () => {
    expect(listRuns(paths)).toEqual([]);
  });

  test("missing runs directory lists nothing", () => {
    expect(listRuns({ ...paths, runs: home.resolve("no-such-dir") })).toEqual([]);
  });

  test("summaries carry per-status counts like the old jq and sort by started desc", () => {
    writeRun(
      home,
      runState("older", "2026-09-01T10:00:00Z", [
        node("n1", "waiting"),
        node("n2", "waiting"),
        node("n3", "running"),
        node("n4", "done"),
        node("n5", "error"),
        node("n6", "skipped"),
        node("n7", "bogus"),
      ]),
    );
    writeRun(home, runState("newer", "2026-09-02T10:00:00Z", []));

    const runs = listRuns(paths);

    const expected: RunSummary[] = [
      {
        run_id: "newer",
        title: "Run newer",
        status: "running",
        started: "2026-09-02T10:00:00Z",
        finished: null,
        harness_session: "sess-1",
        counts: { waiting: 0, running: 0, done: 0, error: 0, skipped: 0 },
      },
      {
        run_id: "older",
        title: "Run older",
        status: "running",
        started: "2026-09-01T10:00:00Z",
        finished: null,
        harness_session: "sess-1",
        counts: { waiting: 2, running: 1, done: 1, error: 1, skipped: 1 },
      },
    ];
    expect(runs).toEqual(expected);
  });

  test("equal started keeps the old sort_by | reverse order (name-descending)", () => {
    const started = "2026-09-02T10:00:00Z";
    writeRun(home, runState("a-run", started, []));
    writeRun(home, runState("b-run", started, []));
    writeRun(home, runState("c-run", started, []));

    expect(listRuns(paths).map((run) => run.run_id)).toEqual(["c-run", "b-run", "a-run"]);
  });

  test("skips invalid ids, plain files, symlinked dirs and dirs without state.json quietly", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      writeRun(home, runState("kept", "2026-09-02T10:00:00Z", []));
      // Valid state, invalid directory name.
      home.write("runs/.hidden/state.json", JSON.stringify(runState("hidden", "2026-09-03T00:00:00Z", [])));
      home.write("runs/bad id/state.json", JSON.stringify(runState("bad id", "2026-09-03T00:00:00Z", [])));
      // A stray file where a run directory is expected.
      writeFileSync(home.resolve("runs/stray.json"), "{}");
      // A run directory created but not yet populated.
      mkdirSync(home.resolve("runs/empty-run"));
      // A symlink to a perfectly valid run directory living outside runs/.
      home.write("elsewhere/state.json", JSON.stringify(runState("linked", "2026-09-03T00:00:00Z", [])));
      symlinkSync(home.resolve("elsewhere"), join(paths.runs, "linked"));

      expect(listRuns(paths).map((run) => run.run_id)).toEqual(["kept"]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("skips an unparsable state.json with one stderr line and keeps the rest", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      writeRun(home, runState("good", "2026-09-02T10:00:00Z", []));
      home.write("runs/broken/state.json", "{ not json");
      home.write("runs/not-object/state.json", "[]");
      home.write("runs/no-nodes/state.json", JSON.stringify({ run_id: "no-nodes", nodes: "nope" }));

      expect(listRuns(paths).map((run) => run.run_id)).toEqual(["good"]);

      expect(errorSpy).toHaveBeenCalledTimes(3);
      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.find((line) => line.startsWith("runs: skipping broken: "))).toBeDefined();
      expect(lines).toContain("runs: skipping not-object: state.json is not a JSON object");
      expect(lines).toContain("runs: skipping no-nodes: nodes is not an array");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("readRun", () => {
  let home: TempHome;
  let paths: OrchPaths;

  beforeEach(() => {
    home = TempHome.create();
    paths = orchPaths(home.path);
  });

  afterEach(() => {
    home.dispose();
  });

  test("returns the whole state.json for an existing run", () => {
    const state = runState("20260902-193000-a1b2", "2026-09-02T19:30:00Z", [node("n1", "done")]);
    state.edges = [["n1", "n2"]];
    writeRun(home, state);

    expect(readRun(paths, state.run_id)).toEqual({ kind: "ok", run: state });
  });

  test("missing for an unknown id", () => {
    expect(readRun(paths, "nope")).toEqual({ kind: "missing" });
  });

  test("missing for a run directory without state.json", () => {
    mkdirSync(home.resolve("runs/empty-run"));
    expect(readRun(paths, "empty-run")).toEqual({ kind: "missing" });
  });

  test("missing for an invalid id even when the path would resolve", () => {
    home.write("runs/.hidden/state.json", JSON.stringify(runState("hidden", "2026-09-03T00:00:00Z", [])));
    expect(readRun(paths, ".hidden")).toEqual({ kind: "missing" });
    expect(readRun(paths, "../profiles.json")).toEqual({ kind: "missing" });
    expect(readRun(paths, "")).toEqual({ kind: "missing" });
  });

  test("corrupt with the parser's reason for invalid JSON", () => {
    home.write("runs/broken/state.json", "{ not json");

    const result = readRun(paths, "broken");

    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("corrupt when the JSON is not a run object", () => {
    home.write("runs/list/state.json", "[1,2]");
    home.write("runs/no-nodes/state.json", '{"run_id":"no-nodes"}');

    expect(readRun(paths, "list")).toEqual({
      kind: "corrupt",
      reason: "state.json is not a JSON object",
    });
    expect(readRun(paths, "no-nodes")).toEqual({ kind: "corrupt", reason: "nodes is not an array" });
  });
});
