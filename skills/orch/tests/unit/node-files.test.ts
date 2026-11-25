import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRun, saveRun } from "../../core/state/store.ts";
import { readNodeField, nodeFromFiles } from "../../core/state/node-files.ts";

const mk = () => {
  const home = mkdtempSync(join(tmpdir(), "nf-"));
  mkdirSync(join(home, "runs", "r1"), { recursive: true });
  return home;
};
const raw = (home: string) => JSON.parse(readFileSync(join(home, "runs", "r1", "state.json"), "utf8"));
const legacy = (home: string) =>
  writeFileSync(join(home, "runs", "r1", "state.json"), JSON.stringify({ run_id: "r1", status: "running", edges: [], nodes: [
    { id: "a", status: "done", selection_history: [{ seq: 1, stage: "solver" }, { seq: 2, stage: "solver" }], log_tail: ["x", "y"], attempts: [{ job_id: "j1", log_tail: ["old"] }] },
    { id: "b", status: "waiting", selection_history: [], log_tail: [], attempts: [] },
  ] }));

test("a legacy run migrates on its first save, and reads back whole", async () => {
  const home = mk();
  legacy(home);
  const run = (await loadRun(home, "r1"))!;
  expect(run.nodes[0].attempts.length).toBe(1);
  await saveRun(home, "r1", run);
  const s = raw(home).nodes[0];
  expect(s.selection_history).toBeUndefined();
  expect(s.log_tail).toBeUndefined();
  expect(s.attempts).toBeUndefined();
  expect(s.attempt_count).toBe(1);
  expect(s.selection_count).toBe(2);
  expect(s.last_selection.seq).toBe(2);
  expect(existsSync(join(home, "runs", "r1", "nodes", "b", "selections.jsonl"))).toBe(false);
  const again = (await loadRun(home, "r1"))!;
  expect(again.nodes[0].selection_history.map((e: any) => e.seq)).toEqual([1, 2]);
  expect(again.nodes[0].log_tail).toEqual(["x", "y"]);
  expect(again.nodes[0].attempts[0].log_tail).toEqual(["old"]);
  expect(again.nodes[1].attempts).toEqual([]);
});

test("an untouched field is not read, a changed one is appended or replaced", async () => {
  const home = mk();
  legacy(home);
  await saveRun(home, "r1", (await loadRun(home, "r1"))!);
  const sel = join(home, "runs", "r1", "nodes", "a", "selections.jsonl");
  const before = readFileSync(sel, "utf8");
  const run = (await loadRun(home, "r1"))!;
  run.nodes[0].status = "error";
  await saveRun(home, "r1", run);
  expect(readFileSync(sel, "utf8")).toBe(before);

  const r2 = (await loadRun(home, "r1"))!;
  r2.nodes[0].selection_history = [...r2.nodes[0].selection_history, { seq: 3 }];
  r2.nodes[0].log_tail = ["z"];
  r2.nodes[0].attempts = [...r2.nodes[0].attempts, { job_id: "j2" }];
  await saveRun(home, "r1", r2);
  expect(readFileSync(sel, "utf8").trim().split("\n").length).toBe(3);
  const s = raw(home).nodes[0];
  expect([s.selection_count, s.last_selection.seq, s.attempt_count]).toEqual([3, 3, 2]);
  expect(readNodeField(home, "r1", "a", "log_tail")).toEqual(["z"]);
  expect(readNodeField(home, "r1", "a", "attempts").map((a: any) => a.job_id)).toEqual(["j1", "j2"]);
  // untouched node keeps its summary
  expect(raw(home).nodes[1].attempt_count).toBe(0);
  expect(nodeFromFiles(home, "r1", { id: "a" }).selection_history.length).toBe(3);

  const r3 = (await loadRun(home, "r1"))!;
  r3.nodes[0].attempts = [];
  await saveRun(home, "r1", r3);
  expect(readNodeField(home, "r1", "a", "attempts")).toEqual([]);
  expect(raw(home).nodes[0].attempt_count).toBe(0);
});

test("a node loaded without attempts keeps its first archived attempt on save (retry lost it)", async () => {
  const home = mk();
  writeFileSync(join(home, "runs", "r1", "state.json"), JSON.stringify({ run_id: "r1", status: "running", edges: [], nodes: [{ id: "a", status: "error", job_id: "old-job" }] }));
  const run = (await loadRun(home, "r1"))!;
  const n: any = run.nodes[0];
  n.attempts = [...(n.attempts ?? []), { job_id: n.job_id, reason: "retry" }];
  await saveRun(home, "r1", run);
  expect((readNodeField(home, "r1", "a", "attempts") as any[]).map((x) => x.job_id)).toEqual(["old-job"]);
  expect(raw(home).nodes[0].attempt_count).toBe(1);
});
