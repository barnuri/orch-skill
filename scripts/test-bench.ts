#!/usr/bin/env bun
// Speed benchmark of the orch test runner: per-file seconds, total wall, the 10 slowest files.
//   bun scripts/test-bench.ts [--full | --changed | <fragment>...]   (default: fast tier; args go to tests/run.ts)
//   ORCH_TEST_SPAWN=1 bun scripts/test-bench.ts   benchmark the old one-process-per-command mode for comparison
// Appends one line per run to ${TMPDIR}/orch-test-bench.jsonl so the speed can be tracked over time.
import { appendFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { REPO_DIR } from "./lib/util.ts";

const args = process.argv.slice(2);
const t0 = Date.now();
const p = Bun.spawn([process.execPath, "skills/orch/tests/run.ts", ...args], { cwd: REPO_DIR, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
const rc = await p.exited;
const wall = (Date.now() - t0) / 1000;

const rows: { id: string; secs: number; pass: number; fail: number }[] = [];
for (const l of err.split("\n")) {
  const m = /^(\S+)\s+(\d+) passed, (\d+) failed\s+\(([\d.]+)s\)/.exec(l);
  if (m) rows.push({ id: m[1]!, pass: Number(m[2]), fail: Number(m[3]), secs: Number(m[4]) });
}
rows.sort((a, b) => b.secs - a.secs);
const sum = rows.reduce((n, r) => n + r.secs, 0);
console.log("per file (slowest first):");
for (const r of rows) console.log(`  ${r.id.padEnd(34)} ${r.secs.toFixed(1).padStart(6)}s  ${r.pass} passed, ${r.fail} failed`);
console.log("\ntop 10 slowest: " + rows.slice(0, 10).map((r) => `${r.id} ${r.secs.toFixed(1)}s`).join(", "));
console.log(`files ${rows.length}, sum of file seconds ${sum.toFixed(1)}s, wall ${wall.toFixed(1)}s, exit ${rc}, load ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cpus, mode ${process.env.ORCH_TEST_SPAWN === "1" ? "spawn" : "in-process"}`);
const failed = rows.filter((r) => r.fail > 0).map((r) => r.id);
if (failed.length || rc !== 0) console.log(`failing: ${failed.join(" ") || "(see run.ts output)"}`);
try {
  appendFileSync(`${(process.env.TMPDIR || tmpdir()).replace(/\/+$/, "")}/orch-test-bench.jsonl`, JSON.stringify({ at: new Date().toISOString(), args, wall, files: rows.length, sum, rc, spawn: process.env.ORCH_TEST_SPAWN === "1" }) + "\n");
} catch {}
void out;
process.exit(rc === 75 ? 75 : 0);
