#!/usr/bin/env bun
// Runner for tests/**/*.test.ts. Each file runs as its own `bun test` process in a parallel pool.
//   bun skills/orch/tests/run.ts               FAST (default): tests/unit, under 30 s
//   bun skills/orch/tests/run.ts --changed[=ref]  fast tier + tests mapped from changed files (changed-map.txt)
//   bun skills/orch/tests/run.ts --full        every category, slowest first, 300 s budget
//   bun skills/orch/tests/run.ts <fragment>... only files whose id (<category>/<name>) contains a fragment
//   --budget SECS   stop starting files after SECS, give running files ORCH_TEST_BUDGET_GRACE (20) more, then kill;
//                   progress goes to $TMPDIR/orch-test-progress.json (ORCH_TEST_PROGRESS); exit 75
//   --resume        run only the files not passed in the recorded run
//   ORCH_TEST_JOBS=N (default: cores minus current load, between half the cores and cores minus 2), ORCH_TEST_FILE_CAP=SECS (15 fast, 30 otherwise)
//   --trace         count the real orch spawns and in-process calls of each file (ORCH_TEST_TRACE) and print them on the file line
//   ORCH_TEST_SPAWN=1  run every orch command as a real process instead of in-process (tests/helpers/inproc.ts)
//   Each file runs as its own `bun test` process; the tests inside a file run in order. `bun test skills/orch/tests --parallel` also works.
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { tmpdir, cpus, loadavg } from "node:os";
import { templateHome } from "./helpers/template.ts";

const TESTS_DIR = import.meta.dir;
const REPO = resolve(TESTS_DIR, "../../..");
const tmp = (process.env.TMPDIR || tmpdir()).replace(/\/+$/, "");
const PROGRESS = process.env.ORCH_TEST_PROGRESS || `${tmp}/orch-test-progress.json`;
const TIMINGS = process.env.ORCH_TEST_TIMINGS || `${tmp}/orch-ts-test-timings.json`;
const GRACE = Number(process.env.ORCH_TEST_BUDGET_GRACE ?? 20);

let mode = "", ref = "HEAD", budgetArg = "", resume = false, traceOn = false;
const frags: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--fast") mode = "fast";
  else if (a === "--full") mode = "full";
  else if (a === "--changed") mode = "changed";
  else if (a.startsWith("--changed=")) { mode = "changed"; ref = a.slice(10); }
  else if (a === "--budget") budgetArg = argv[++i] ?? "x";
  else if (a.startsWith("--budget=")) budgetArg = a.slice(9);
  else if (a === "--resume") resume = true;
  else if (a === "--trace") traceOn = true;
  else if (a === "-h" || a === "--help") { console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
  else if (a.startsWith("-")) { console.error(`run.ts: unknown option ${a} (see --help)`); process.exit(2); }
  else frags.push(a);
}
if (!/^\d*$/.test(budgetArg)) { console.error("run.ts: --budget needs whole seconds"); process.exit(2); }

type St = "passed" | "failed" | "not_run";
const priorPassed: string[] = [];
let resumeIds: string[] = [];
if (resume) {
  if (!existsSync(PROGRESS)) { console.error(`run.ts: no partial run recorded in ${PROGRESS}; run without --resume`); process.exit(2); }
  const rec = JSON.parse(readFileSync(PROGRESS, "utf8"));
  mode = rec.mode;
  if (!mode) { console.error(`run.ts: ${PROGRESS} has no mode; run without --resume`); process.exit(2); }
  for (const [id, st] of Object.entries<string>(rec.files)) (st === "passed" ? priorPassed : resumeIds).push(id);
  frags.length = 0;
}
if (!mode) mode = frags.length ? "pick" : "fast";
const budget = budgetArg ? Number(budgetArg) : mode === "full" ? 300 : 0;
const jobsEnv = process.env.ORCH_TEST_JOBS;
const ncpu = cpus().length;
// Files wait on process starts more than they use the CPU, so a loaded machine still gets half the cores; never more than cores minus 2.
const jobs = jobsEnv ? Number(jobsEnv) : Math.max(Math.min(Math.ceil(ncpu / 2), ncpu - 2), Math.min(ncpu - 2, Math.ceil(ncpu - loadavg()[0])));
const cap = Number(process.env.ORCH_TEST_FILE_CAP ?? (mode === "fast" ? 15 : 30));

const idOf = (f: string) => `${basename(dirname(f))}/${basename(f).replace(/\.test\.ts$/, "")}`;
const fileOf = (id: string) => join(TESTS_DIR, `${id}.test.ts`);
const allIn = (cat: string) => (existsSync(join(TESTS_DIR, cat)) ? readdirSync(join(TESTS_DIR, cat)).filter((n) => n.endsWith(".test.ts")).map((n) => join(TESTS_DIR, cat, n)) : []);
const categories = () => readdirSync(TESTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "helpers").map((d) => d.name);
const allFiles = () => categories().flatMap(allIn);

function changedTests(): string[] {
  const sh = (args: string[]) => Bun.spawnSync(["git", "-C", REPO, ...args]).stdout.toString().split("\n").filter(Boolean);
  const paths = [...new Set([...sh(["diff", "--name-only", ref, "--"]), ...sh(["ls-files", "--others", "--exclude-standard", "--", "skills/orch"])])];
  const map = new Map<string, string[]>();
  const mapFile = join(TESTS_DIR, "changed-map.txt");
  if (existsSync(mapFile)) for (const l of readFileSync(mapFile, "utf8").split("\n")) {
    const t = l.replace(/#.*/, "").trim().split(/\s+/);
    if (t[0]) map.set(t[0], t.slice(1));
  }
  const files = allFiles(), out = new Set<string>();
  for (const p of paths) {
    if (/^skills\/orch\/tests\/[^/]+\/[^/]+\.test\.ts$/.test(p)) { if (existsSync(join(REPO, p))) out.add(join(REPO, p)); continue; }
    const m = p.match(/^skills\/orch\/(?:core|scripts\/lib)\/(?:.*\/)?([^/]+?)\.(?:ts|sh)$/) ?? p.match(/^skills\/orch\/scripts\/(dispatch|announce)\.sh$/);
    if (!m) continue;
    const stem = m[1], names = [stem, ...(map.get(stem) ?? [])];
    for (const f of files) {
      const n = basename(f).replace(/\.test\.ts$/, "");
      if (names.some((s) => n === s || n.startsWith(s + "-"))) out.add(f);
    }
  }
  return [...out];
}

let candidates: string[];
if (resume) candidates = resumeIds.map(fileOf);
else if (mode === "fast") candidates = allIn("unit");
else if (mode === "full" || mode === "pick") candidates = allFiles();
else candidates = [...new Set([...allIn("unit"), ...changedTests()])];

let files = candidates.filter((f) => existsSync(f) && (!frags.length || frags.some((p) => idOf(f).includes(p))));
if (!files.length && !priorPassed.length) { console.error("no test files match"); process.exit(1); }

let timings: Record<string, number> = {};
try { timings = JSON.parse(readFileSync(TIMINGS, "utf8")); } catch {}
const weight = (f: string) => (mode === "changed" && f.startsWith(join(TESTS_DIR, "unit/")) ? 1e6 : timings[idOf(f)] ?? 1e5);
files.sort((a, b) => weight(b) - weight(a));

const t0 = Date.now();
const homeTemplate = templateHome();
const deadline = budget > 0 ? t0 + budget * 1000 : 0;
if (budget > 0) console.error(`budget: ${budget}s (+${GRACE}s grace), progress: ${PROGRESS}`);

interface Res { id: string; rc: number; secs: number; why: "ok" | "timeout" | "budget"; out: string; pass: number; fail: number; trace: string }
const results: Res[] = [];
const skipped: string[] = [];

async function runOne(f: string): Promise<void> {
  const id = idOf(f), start = Date.now();
  const traceFile = traceOn ? join(tmp, `orch-trace-${process.pid}-${id.replace("/", "-")}.tsv`) : "";
  const proc = Bun.spawn(["bun", "test", "--timeout", String(cap * 1000), f], { env: { ...process.env, ORCH_NO_ANNOUNCE: "1", ORCH_TEST_HOME_TEMPLATE: homeTemplate, ...(traceOn ? { ORCH_TEST_TRACE: traceFile } : {}) }, stdout: "pipe", stderr: "pipe", detached: true } as any);
  let why: Res["why"] = "ok";
  const killer = setInterval(() => {
    const now = Date.now();
    const hit = now - start >= cap * 1000 ? "timeout" : deadline && now >= deadline + GRACE * 1000 ? "budget" : "";
    if (hit && why === "ok") { why = hit; try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill(9); } }
  }, 200);
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const rc = await proc.exited;
  clearInterval(killer);
  try { process.kill(-proc.pid, "SIGTERM"); } catch {}
  const out = o + e;
  const pass = Number(out.match(/^\s*(\d+) pass/m)?.[1] ?? 0), fail = Number(out.match(/^\s*(\d+) fail/m)?.[1] ?? 0);
  if (why === "budget") { skipped.push(id); return; }
  let trace = "";
  if (traceOn) {
    const n: Record<string, number> = {};
    try { for (const l of readFileSync(traceFile, "utf8").split("\n")) if (l) n[l.split("\t")[0]!] = (n[l.split("\t")[0]!] ?? 0) + 1; } catch {}
    trace = `  [${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(", ")}]`;
  }
  const r: Res = { id, rc, secs: (Date.now() - start) / 1000, why, out, pass, fail, trace };
  results.push(r);
}

const limit = jobs > 0 ? jobs : files.length || 1;
let next = 0;
const running = new Set<Promise<void>>();
while (next < files.length || running.size) {
  while (next < files.length && running.size < limit) {
    const f = files[next++];
    if (deadline && Date.now() >= deadline) { skipped.push(idOf(f)); continue; }
    const p: Promise<void> = runOne(f).finally(() => running.delete(p));
    running.add(p);
  }
  if (running.size) await Promise.race(running);
}

let totalPass = 0, totalFail = 0, bad = false;
const status: Record<string, St> = Object.fromEntries(priorPassed.map((i) => [i, "passed" as St]));
results.sort((a, b) => a.id.localeCompare(b.id));
for (const r of results) {
  totalPass += r.pass; totalFail += r.fail;
  const ok = r.why === "ok" && r.rc === 0 && r.fail === 0;
  status[r.id] = ok ? "passed" : "failed";
  if (r.why === "timeout") { bad = true; console.log(`=== ${r.id} TIMEOUT: killed after the ${cap}s per-file cap (ORCH_TEST_FILE_CAP) ===\n${r.out.split("\n").slice(-20).join("\n")}`); }
  else if (r.rc !== 0) { bad = true; console.log(`=== ${r.id} FAILED (exit ${r.rc}) ===\n${r.out}`); }
  console.error(`${r.id.padEnd(30)} ${String(r.pass).padStart(4)} passed, ${r.fail} failed  (${r.secs.toFixed(1)}s)${r.trace}`);
  timings[r.id] = timings[r.id] === undefined ? r.secs : Math.round((timings[r.id]! + r.secs) * 5) / 10;
}
if (results.length) {
  try { writeFileSync(TIMINGS, JSON.stringify(timings)); } catch {}
  console.error("\nslowest: " + [...results].sort((a, b) => b.secs - a.secs).slice(0, 5).map((r) => `${r.id} ${r.secs.toFixed(1)}s`).join(", "));
}
console.log(`\n${totalPass} passed, ${totalFail} failed (${mode} tier, ${results.length} files, ${Math.round((Date.now() - t0) / 1000)}s wall)`);
for (const id of skipped) status[id] = "not_run";
if (skipped.length) {
  writeFileSync(PROGRESS + ".tmp", JSON.stringify({ mode, files: status }, null, 1));
  renameSync(PROGRESS + ".tmp", PROGRESS);
  const total = Object.keys(status).length;
  console.log(`not run (${skipped.length}): ${skipped.join(" ")}`);
  console.log(`PARTIAL: ${total - skipped.length} of ${total} files, run again with --resume`);
  process.exit(75);
}
if ((budget > 0 || resume) && existsSync(PROGRESS)) Bun.spawnSync(["trash", PROGRESS]);
process.exit(bad || totalFail > 0 ? 1 : 0);
