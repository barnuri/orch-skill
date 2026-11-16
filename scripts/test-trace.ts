#!/usr/bin/env bun
// Where does a test file spend its time? Usage: bun scripts/test-trace.ts <fragment>...
// Runs each matching tests/<category>/<name>.test.ts alone with ORCH_TEST_TRACE and prints the wall time,
// the slowest tests, the number and total time of in-process calls, real orch spawns and spawns made by the worker.
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TESTS = resolve(import.meta.dir, "../skills/orch/tests");
const frags = process.argv.slice(2);
if (!frags.length) { console.error("usage: bun scripts/test-trace.ts <fragment>..."); process.exit(2); }
const files = readdirSync(TESTS, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "helpers")
  .flatMap((d) => readdirSync(join(TESTS, d.name)).filter((n) => n.endsWith(".test.ts")).map((n) => `${d.name}/${n.replace(/\.test\.ts$/, "")}`))
  .filter((id) => frags.some((f) => id.includes(f)));

for (const id of files) {
  const trace = join(mkdtempSync(join(tmpdir(), "orch-trace-")), "trace.tsv");
  const t0 = Date.now();
  const p = Bun.spawnSync(["bun", "test", "--timeout", "300000", join(TESTS, `${id}.test.ts`)], { env: { ...process.env, ORCH_TEST_TRACE: trace, ORCH_NO_ANNOUNCE: "1" } });
  const wall = (Date.now() - t0) / 1000;
  const out = p.stdout.toString() + p.stderr.toString();
  console.log(`\n== ${id}: ${wall.toFixed(1)}s, exit ${p.exitCode}`);
  const tests = [...out.matchAll(/^\((pass|fail)\) (.*) \[([\d.]+)(ms|s)\]/gm)].map((m) => ({ name: m[2]!, ms: Number(m[3]) * (m[4] === "s" ? 1000 : 1) }));
  for (const t of tests.sort((a, b) => b.ms - a.ms).slice(0, 5)) console.log(`  test ${(t.ms / 1000).toFixed(1)}s  ${t.name.slice(0, 80)}`);
  let rows: string[][] = [];
  try { rows = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")); } catch {}
  const kinds = new Map<string, { n: number; ms: number }>();
  for (const [k, ms] of rows) { const e = kinds.get(k!) ?? { n: 0, ms: 0 }; e.n++; e.ms += Number(ms); kinds.set(k!, e); }
  for (const [k, e] of kinds) console.log(`  ${k.padEnd(14)} ${String(e.n).padStart(4)} calls  ${(e.ms / 1000).toFixed(1)}s total`);
  const slow = rows.filter((r) => r[0] === "inproc" || r[0] === "spawn").sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 6);
  for (const r of slow) console.log(`  slow ${r[0]} ${r[1]}ms ${r[2]}`);
  const wk = new Map<string, number>();
  for (const r of rows.filter((x) => x[0]!.startsWith("worker-"))) { const c = (r[2] ?? "").slice(0, 50); wk.set(c, (wk.get(c) ?? 0) + 1); }
  for (const [c, n] of [...wk].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  worker spawned x${n} ${c}`);
}
