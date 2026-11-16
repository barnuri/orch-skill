#!/usr/bin/env bun
// The full gate: bash suite, TypeScript suite, typecheck and lint, run concurrently.
//
//   bun scripts/test-all.ts            run all four; both suites run under their 300 s budget
//   bun scripts/test-all.ts --changed  bun test --changed + orch run.ts --changed + cached typecheck, no heavy lock
//   bun scripts/test-all.ts --resume   rerun only the suites that stopped at their budget, with --resume
//
// Exit 0 = all passed, 1 = a failure, 75 = a suite stopped at its budget: it prints
// `PARTIAL: ... run again with --resume`; run --resume until it exits 0 or 1. Never raise the budget.
// The suite results between runs live in ${TMPDIR}/orch-test-all-progress (ORCH_TEST_ALL_PROGRESS).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heavyLockAcquire } from "./heavy-test-lock.ts";
import { REPO_DIR, tmpDir, trashPath } from "./lib/util.ts";

process.chdir(REPO_DIR);
const arg = process.argv[2] ?? "";
if (arg !== "" && arg !== "--resume" && arg !== "--changed") {
  console.error(`test-all.ts: unknown argument ${arg} (see the header)`);
  process.exit(2);
}
const resume = arg === "--resume";
const changedMode = arg === "--changed";
const STATE = (process.env["ORCH_TEST_ALL_PROGRESS"] ?? `${tmpDir()}/orch-test-all-progress`).replace(/\/\/+/g, "/");
if (resume && !existsSync(STATE)) {
  console.error(`test-all.ts: no partial run recorded in ${STATE}; run without --resume`);
  process.exit(2);
}
const prev = new Map<string, number>();
if (existsSync(STATE)) {
  for (const l of readFileSync(STATE, "utf8").split("\n")) {
    const [k, v] = l.split(" ");
    if (k && v !== undefined) prev.set(k, Number(v));
  }
}

// One machine-wide heavy-test slot covers every job below (they see ORCH_TEST_LOCK_HELD and do not ask again).
if (!changedMode) await heavyLockAcquire("test-all.ts (full gate)");

const BUN = process.execPath;
if (changedMode) process.env["ORCH_HERDR"] = "0";
async function job(cmd: string[]): Promise<{ code: number; log: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env as Record<string, string> });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, log: out + err };
}

type Res = { code: number; log: string } | null;
const jobs: Record<string, Promise<Res>> = {};
const start = (name: string, cmd: string[]): void => {
  jobs[name] = job(cmd);
};
if (changedMode) {
  start("bash", [BUN, "skills/orch/tests/run.ts", "--changed"]);
  start("bun", [BUN, "test", "--timeout", "300000", "--parallel=6", "--changed", "src"]);
  start("types", [BUN, "scripts/typecheck.ts"]);
} else if (!resume) {
  start("bash", [BUN, "skills/orch/tests/run.ts", "--full"]);
  start("bun", [BUN, "scripts/test-budget.ts"]);
  start("types", [BUN, "scripts/typecheck.ts"]);
  start("lint", [BUN, "scripts/lint-optional.ts"]);
} else {
  if (prev.get("bash") === 75) start("bash", [BUN, "skills/orch/tests/run.ts", "--resume"]);
  if (prev.get("bun") === 75) start("bun", [BUN, "scripts/test-budget.ts", "--resume"]);
}
const names = ["bash", "bun", "types", "lint"];
const rc: Record<string, number> = {};
const logs: Record<string, string> = {};
for (const n of names) {
  const r = jobs[n] ? await jobs[n] : null;
  if (r) {
    rc[n] = r.code;
    logs[n] = r.log;
  } else rc[n] = prev.get(n) ?? 0;
}
const tail = (s: string, n: number): string => s.split("\n").slice(-n - 1).join("\n");
const report = (n: string, lines: number, label: string): void => {
  const log = logs[n];
  if (log === undefined) return;
  if (rc[n] === 0) return;
  if (rc[n] === 75) {
    console.log(`== ${label} stopped at its budget`);
    console.log(log.split("\n").filter((l) => l.startsWith("PARTIAL:")).join("\n"));
  } else {
    console.log(`== ${label} FAILED`);
    console.log(tail(log, lines));
  }
};
report("bash", 40, "bash suite");
report("bun", 40, "bun test");
report("types", 20, "typecheck");
report("lint", 30, "lint (real errors)");
if (logs["lint"] !== undefined) process.stdout.write(logs["lint"]);
for (const n of ["bash", "bun"]) {
  const log = logs[n];
  if (log === undefined) continue;
  const hit = log.split("\n").filter((l) => !l.startsWith("PARTIAL:") && (/passed, [0-9]+ failed/.test(l) || l.startsWith("bun: ")));
  if (hit.length) console.log(hit[hit.length - 1]);
}
if (logs["types"] !== undefined) console.log(logs["types"].trimEnd().split("\n").pop());

let code = 0;
const partial: string[] = [];
for (const n of names) {
  if (rc[n] === 75) partial.push(n);
  else if (rc[n] !== 0) code = 1;
}
if (partial.length) {
  const tmp = join(tmpDir(), `orch-test-all-progress.tmp.${process.pid}`);
  writeFileSync(tmp, names.map((n) => `${n} ${rc[n]}`).join("\n") + "\n");
  renameSync(tmp, STATE);
  console.log(`PARTIAL: suites left: ${partial.join(" ")}, run again with --resume`);
  process.exit(75);
}
if (existsSync(STATE)) trashPath(STATE, tmpDir());
process.exit(code);
