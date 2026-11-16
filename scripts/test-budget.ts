#!/usr/bin/env bun
// The TypeScript suite under a time budget, in chunks of test files (bun run test:budget / test:resume).
//
//   bun scripts/test-budget.ts [--budget SECS] [--chunk N]   run every src/**/*.test.ts(x), N files per
//                                                            `bun test` call (default 25)
//   bun scripts/test-budget.ts --resume                      run only the files that have not passed
//
// --budget SECS (default 300): no chunk starts after SECS; a running chunk gets 20 s more
// (ORCH_TEST_BUDGET_GRACE), then its process group is killed. Each file's result (passed, failed,
// not_run; a chunk's result applies to all its files) goes to ${TMPDIR}/orch-bun-test-progress.json
// (ORCH_BUN_TEST_PROGRESS). With files left the script prints `PARTIAL: N of M files, run again with
// --resume` and exits 75: run --resume until it exits 0 or 1. Never raise the budget instead.
// A run that has run every file clears the progress file.
// Seams for tests: ORCH_BUN_TEST_ROOT (folder to scan, default src), ORCH_BUN_TEST_CMD (command the
// file paths are appended to, default the `bun test` flags of `bun run test`).
import { Glob } from "bun";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { heavyLockAcquire } from "./heavy-test-lock.ts";
import { REPO_DIR, sleep, tmpDir, trashPath } from "./lib/util.ts";

process.chdir(REPO_DIR);
process.env["ORCH_HERDR"] = "0";

let budget = "300";
let resume = false;
let chunkArg = process.env["ORCH_BUN_TEST_CHUNK"] ?? "25";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (a === "--budget") budget = argv[++i] ?? "x";
  else if (a.startsWith("--budget=")) budget = a.slice(9);
  else if (a === "--chunk") chunkArg = argv[++i] ?? "x";
  else if (a.startsWith("--chunk=")) chunkArg = a.slice(8);
  else if (a === "--resume") resume = true;
  else if (a === "-h" || a === "--help") {
    const src = readFileSync(import.meta.path, "utf8").split("\n");
    console.log(src.slice(1, src.findIndex((l) => l.startsWith("import "))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  } else {
    console.error(`test-budget.ts: unknown argument ${a} (see --help)`);
    process.exit(2);
  }
}
if (!/^[0-9]+$/.test(budget)) {
  console.error("test-budget.ts: --budget needs whole seconds");
  process.exit(2);
}
if (!/^[0-9]+$/.test(chunkArg) || Number(chunkArg) === 0) {
  console.error("test-budget.ts: --chunk needs a positive number");
  process.exit(2);
}
const chunk = Number(chunkArg);
const GRACE = Number(process.env["ORCH_TEST_BUDGET_GRACE"] ?? 20);
const PROGRESS = (process.env["ORCH_BUN_TEST_PROGRESS"] ?? `${tmpDir()}/orch-bun-test-progress.json`).replace(/\/\/+/g, "/");
const TEST_ROOT = process.env["ORCH_BUN_TEST_ROOT"] ?? "src";
const CMD = (process.env["ORCH_BUN_TEST_CMD"] ?? `${process.execPath} test --timeout 300000 --parallel=6 --retry=1`).split(/\s+/).filter(Boolean);

type St = "passed" | "failed" | "not_run";
const status = new Map<string, St>();
let files: string[] = [];
if (resume) {
  if (!existsSync(PROGRESS)) {
    console.error(`test-budget.ts: no partial run recorded in ${PROGRESS}; run without --resume`);
    process.exit(2);
  }
  const prior = JSON.parse(readFileSync(PROGRESS, "utf8")).files as Record<string, St>;
  for (const [f, st] of Object.entries(prior)) {
    if (st === "passed") status.set(f, "passed");
    else if (existsSync(f)) files.push(f);
  }
} else {
  const root = resolve(TEST_ROOT);
  for (const f of new Glob("**/*.test.{ts,tsx}").scanSync({ cwd: root })) {
    if (f.includes("node_modules/")) continue;
    files.push(`./${TEST_ROOT.replace(/^\.\//, "")}/${f}`);
  }
  files.sort();
  if (files.length === 0) {
    console.error(`test-budget.ts: no test files under ${TEST_ROOT}`);
    process.exit(1);
  }
}

await heavyLockAcquire("scripts/test-budget.ts (bun suite)");

const deadline = Date.now() + Number(budget) * 1000;
const killAt = deadline + GRACE * 1000;
console.error(`budget: ${budget}s (+${GRACE}s grace), progress: ${PROGRESS}`);
const started = Date.now();
let left = 0;

for (let i = 0; i < files.length; i += chunk) {
  const part = files.slice(i, i + chunk);
  if (Date.now() >= deadline) {
    for (const f of part) status.set(f, "not_run");
    left += part.length;
    continue;
  }
  // Own process group (detached), so a kill at the budget takes bun's workers and servers with it.
  const child = spawn(CMD[0] as string, [...CMD.slice(1), ...part], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let killed = false;
  const exited = new Promise<number>((res) => {
    child.on("close", (c) => res(c ?? 1));
    child.on("error", () => res(127));
  });
  let rc: number | null = null;
  void exited.then((c) => (rc = c));
  while (rc === null) {
    if (Date.now() >= killAt) {
      killed = true;
      try { process.kill(-(child.pid as number), "SIGTERM"); } catch {}
      await sleep(2000);
      try { process.kill(-(child.pid as number), "SIGKILL"); } catch {}
      break;
    }
    await sleep(500);
  }
  if (rc === null) rc = await Promise.race([exited, sleep(3000).then(() => 1)]);
  let st: St;
  if (killed) {
    st = "not_run";
    left += part.length;
  } else if (rc === 0) st = "passed";
  else {
    st = "failed";
    console.log(`=== bun chunk FAILED (exit ${rc}): ${part.join(" ")}`);
    console.log(log.split("\n").slice(-61).join("\n"));
  }
  for (const f of part) status.set(f, st);
  const counts = log.split("\n").filter((l) => /^ *[0-9]+ (pass|fail)$/.test(l)).map((l) => l.trim()).join(" ");
  console.error(`${counts} (${part.length} files: ${st})`);
}

const vals = [...status.values()];
const passed = vals.filter((v) => v === "passed").length;
const failed = vals.filter((v) => v === "failed").length;
console.log(`\nbun: ${passed} passed, ${failed} failed, ${left} not run of ${vals.length} files (${Math.round((Date.now() - started) / 1000)}s wall)`);
if (left > 0) {
  const tmp = `${PROGRESS}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ mode: "bun", files: Object.fromEntries(status) }, null, 1) + "\n");
  renameSync(tmp, PROGRESS);
  console.log(`PARTIAL: ${vals.length - left} of ${vals.length} files, run again with --resume`);
  process.exit(75);
}
if (existsSync(PROGRESS)) trashPath(PROGRESS, tmpDir());
process.exit(failed === 0 ? 0 : 1);
