import { describe, expect, test } from "bun:test";

import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import { listRuns } from "./runs-reader";

const HOUR_MS = 3_600_000;

function writeRun(home: TempHome, runId: string, nodes: object[]): void {
  home.write(
    `runs/${runId}/state.json`,
    JSON.stringify({ run_id: runId, title: "t", harness_session: "s", started: "2026-01-01T00:00:00Z", finished: null, status: "running", nodes, edges: [] }),
  );
}

function base(id: string, status: string, extra: object = {}): object {
  return { id, label: id, status, profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...extra };
}

describe("listRuns stale and updated", () => {
  test("counts quiet running nodes and reports the newest activity", () => {
    const home = TempHome.create();
    try {
      const old = new Date(Date.now() - HOUR_MS).toISOString();
      const fresh = new Date().toISOString();
      writeRun(home, "run-a", [
        base("a", "running", { started: old, updated: old }),
        base("b", "running", { started: old, updated: fresh }),
        base("c", "done", { started: old, finished: old }),
      ]);
      const [summary] = listRuns(orchPaths(home.path));
      expect(summary?.stale).toBe(1);
      expect(summary?.updated).toBe(fresh);
    } finally {
      home.dispose();
    }
  });

  test("omits both fields when nothing applies", () => {
    const home = TempHome.create();
    try {
      writeRun(home, "run-b", [base("a", "waiting")]);
      const [summary] = listRuns(orchPaths(home.path));
      expect(summary).toBeDefined();
      expect("stale" in (summary ?? {})).toBe(false);
      expect("updated" in (summary ?? {})).toBe(false);
    } finally {
      home.dispose();
    }
  });
});
