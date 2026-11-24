import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attemptDurations, deriveReports } from "../../core/quality/derive.ts";
import { seedHome, orch, autoCleanup } from "../helpers";
autoCleanup();

const NODES = [
  {
    id: "impl", status: "done", role: "implementation", profile: "p1", harness: "opencode", model: "hub/m1", actual_model: "m1-real",
    hub: { expected: { model: "copilot/m1" }, actual: { model: "copilot/m1-ran" } },
    attempts: [{ model: "hub/m0", actual_model: "m0-real", profile: "p0", adapter: "claude", error: "ended early without handoff", finished: "2026-01-01T00:10:00Z" }],
    run_segments: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:10:00Z" }, { start: "2026-01-01T00:20:00Z", end: "2026-01-01T00:25:00Z" }],
    started_at: "2026-01-01T00:20:00Z", finished_at: "2026-01-01T00:25:00Z",
    result: { verdict: "full", summary: "ok", follow_up: "none" },
  },
  { id: "verify-R1", status: "done", role: "validation", model: "hub/m2", result: { verdict: "full", summary: "checked", follow_up: "none" }, started_at: "2026-01-01T00:30:00Z", finished_at: "2026-01-01T00:31:00Z" },
  { id: "impl-r2", status: "error", replaces: "R/impl0", model: "hub/m3", error: "boom", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:30Z" },
  { id: "never", status: "waiting" },
  { id: "skipped-unstarted", status: "skipped" },
];
const REQS = [{ id: "R1", status: "done", nodes: ["impl"], verifier: "verify-R1", evidence: [{ note: "verifier verify-R1 fail: gap" }, { note: "verifier verify-R1 pass: verified" }] }];

test("derive: one report per finished attempt with models, verdicts, retries, duration and verifier", () => {
  const rs = deriveReports({ runId: "R", nodes: NODES, reqs: REQS, handoff: (n) => (n.id === "impl" ? "own" : n.id === "verify-R1" ? "generated" : "missing") });
  expect(rs.map((r) => r.id)).toEqual(["impl#1", "impl#2", "verify-R1#1", "impl-r2#1"]);
  const [first, last, ver, rep] = rs as any[];
  expect(first).toMatchObject({ node_status: "retried", model: { requested: "hub/m0", actual: "m0-real" }, profile: "p0", verdict: { value: "error" }, duration_s: 600, handoff_kind: "missing", attempt: { number: 1, total: 2, final: false, retries: 1 } });
  expect(last).toMatchObject({ node_status: "done", model: { requested: "hub/m1", actual: "copilot/m1-ran" }, model_hub_expected: "copilot/m1", verdict: { value: "full" }, duration_s: 300, handoff_kind: "own", node_result: { verdict: "full", summary: "ok" }, attempt: { number: 2, final: true } });
  expect(last.verifier).toEqual([{ req_id: "R1", verifier_node: "verify-R1", verdict: "pass", role: "implementer" }]);
  expect(ver).toMatchObject({ stage: "review", handoff_kind: "generated", duration_s: 60, verifier: [{ req_id: "R1", role: "verifier", verdict: "pass" }] });
  expect(rep).toMatchObject({ verdict: { value: "error" }, attempt: { replaces: "R/impl0", replacement_depth: 1 }, attempt_error: "boom", duration_s: 30 });
});

test("attemptDurations splits segments by attempt end", () => {
  const ends = [Date.parse("2026-01-01T00:10:00Z")];
  expect(attemptDurations([{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:10:00Z" }, { start: "2026-01-01T00:11:00Z", end: "2026-01-01T00:12:00Z" }], ends)).toEqual([600, 60]);
  expect(attemptDurations([], [])).toEqual([null]);
});

test("CLI export includes derived reports for a seeded run and keeps the v1 schema", () => {
  const home = seedHome(), o = orch(home);
  const R = o("run", "start", "quality derive").out.trim();
  expect(o.in('{"op":"add","id":"a","goal":"Alpha"}\n{"op":"add","id":"b","goal":"Beta"}\n', "node", "batch", R).rc).toBe(0);
  const out = join(home, "runs", R, "out", "a");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "handoff.md"), "# Handoff\n\nDone.\n");
  expect(o("node", "update", R, "a", "done").rc).toBe(0);
  expect(o("node", "result", R, "a", "--verdict", "full", "--summary", "alpha done", "--follow-up", "none").rc).toBe(0);
  const res = o("node", "quality", "export", R);
  expect(res.rc).toBe(0);
  const exp = JSON.parse(res.out);
  expect(exp.schema).toBe("orch.quality.v1");
  expect(exp.counts).toEqual({ recorded: 0, derived: 1 });
  expect(exp.reports[0]).toMatchObject({ id: "a#1", node_id: "a", source: "derived", verdict: { value: "full" }, handoff_kind: "own", node_result: { verdict: "full", summary: "alpha done" } });
  expect(JSON.parse(o("node", "quality", "export", R, "--recorded", "only").out).reports).toEqual([]);
  expect(o("node", "quality", "export", R, "--recorded", "all").rc).toBe(2);
});
