#!/usr/bin/env bun
// Speed bench for the TypeScript CLI on a seeded temp home (200 nodes).
// Usage: bun scripts/bench-status.ts [max-seconds-for-run-status]
// Exits 0 when the median of 7 `run status` runs is under the given seconds (default 0.5).
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const limit = Number(process.argv[2] ?? 0.5);
const N = 7;
const repo = join(import.meta.dir, "..");
const dispatch = join(repo, "skills/orch/scripts/dispatch.ts");
const home = mkdtempSync(join(tmpdir(), "orch-bench-"));
const runId = "20260101-000000-bench";
mkdirSync(join(home, "runs", runId), { recursive: true });
copyFileSync(join(repo, "skills/orch/templates/profiles.json"), join(home, "profiles.json"));
const nodes = Array.from({ length: 200 }, (_, i) => ({
  id: `n${i}`, label: `node ${i}`, status: i < 100 ? "done" : i < 105 ? "running" : "waiting", profile: null, adapter: null,
  model: null, model_id: null, job_id: null, session: null, started: "2026-01-01T00:00:00Z", finished: null, error: null,
  log_tail: [], usage: {}, cost: null, prompt: null, dispatch_args: [], attempts: [], role: null, tier: null,
  plan_backed: false, acceptance: null, next_retry_at: null,
}));
const edges = nodes.slice(1).map((n, i) => [nodes[i]!.id, n.id]);
writeFileSync(join(home, "runs", runId, "state.json"), JSON.stringify({ run_id: runId, title: "bench", harness_session: "bench", started: "2026-01-01T00:00:00Z", finished: null, status: "running", nodes, edges }));
const ops = join(home, "ops.jsonl");
writeFileSync(ops, Array.from({ length: 10 }, (_, i) => JSON.stringify({ op: "report", id: `n${i}`, note: "b" })).join("\n") + "\n");

const env = { ...process.env, HARNESS_ORCH_HOME: home, ORCH_NO_ANNOUNCE: "1", ORCH_DIRECT: "1" };
function time(cmd: string[]): number {
  const t = performance.now();
  const r = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const s = (performance.now() - t) / 1000;
  if (r.exitCode !== 0 && process.env.BENCH_VERBOSE) console.error(cmd.join(" "), r.stderr.toString());
  return s;
}
let upd = 0;
const cases: Array<[string, () => string[]]> = [
  ["bun -e 1 (baseline)", () => ["bun", "-e", "1"]],
  ["help", () => ["bun", dispatch, "--help"]],
  ["run status", () => ["bun", dispatch, "run", "status", runId]],
  ["node update", () => ["bun", dispatch, "node", "update", runId, "n150", upd++ % 2 ? "waiting" : "waiting", "--hold", `h${upd}`]],
  ["node batch x10", () => ["bun", dispatch, "node", "batch", runId, "--file", ops]],
];
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)]!;
let statusMed = 0;
console.log(`load: ${(await import("node:os")).loadavg().map((x) => x.toFixed(1)).join(" ")}`);
console.log("case".padEnd(22) + "median s".padStart(10) + "p90 s".padStart(10));
for (const [name, mk] of cases) {
  time(mk());
  const xs = Array.from({ length: N }, () => time(mk()));
  if (name === "run status") statusMed = med(xs);
  console.log(name.padEnd(22) + med(xs).toFixed(3).padStart(10) + p90(xs).toFixed(3).padStart(10));
}
process.exit(statusMed < limit ? 0 : 1);
