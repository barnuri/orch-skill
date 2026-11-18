import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { TESTS_DIR, tempDir, runCmd, autoCleanup, templateHome } from "../helpers";
autoCleanup();

// Fake tree: three unit files (slow, mid, fast) and one failing file elsewhere.
function fakeTree() {
  const T = tempDir();
  const tests = join(T, "skills/orch/tests");
  mkdirSync(join(tests, "unit"), { recursive: true });
  mkdirSync(join(tests, "other"), { recursive: true });
  mkdirSync(join(tests, "helpers"), { recursive: true });
  copyFileSync(join(TESTS_DIR, "run.ts"), join(tests, "run.ts"));
  copyFileSync(join(TESTS_DIR, "helpers/template.ts"), join(tests, "helpers/template.ts"));
  mkdirSync(join(tests, "lib"), { recursive: true });
  copyFileSync(join(TESTS_DIR, "lib/reap.ts"), join(tests, "lib/reap.ts"));
  for (const n of ["slow", "mid", "fast"]) {
    writeFileSync(join(tests, "unit", `${n}.test.ts`), `import {test} from "bun:test";
import {appendFileSync} from "node:fs";
test("${n}", async () => { appendFileSync(${JSON.stringify(join(T, "ran.log"))}, "unit/${n}\\n"); await Bun.sleep(Number(process.env.FAKE_SLEEP_${n} ?? 0) * 1000); });\n`);
  }
  writeFileSync(join(tests, "other/bad.test.ts"), `import {test,expect} from "bun:test";
import {appendFileSync} from "node:fs";
test("bad", () => { appendFileSync(${JSON.stringify(join(T, "ran.log"))}, "other/bad\\n"); expect(1).toBe(2); });\n`);
  writeFileSync(join(T, "timings.json"), JSON.stringify({ "unit/slow": 50, "unit/mid": 10, "unit/fast": 5, "other/bad": 1 }));
  const env = { ORCH_TEST_HOME_TEMPLATE: templateHome(), ORCH_TEST_TIMINGS: join(T, "timings.json"), ORCH_TEST_PROGRESS: join(T, "progress.json"), ORCH_TEST_BUDGET_GRACE: "3", ORCH_TEST_JOBS: "2" };
  const run = (args: string[], extra: Record<string, string> = {}) => runCmd(["bun", join(tests, "run.ts"), ...args], { env: { ...env, ...extra } });
  return { T, run, progress: join(T, "progress.json"), ran: () => (existsSync(join(T, "ran.log")) ? readFileSync(join(T, "ran.log"), "utf8") : "") };
}

test("budget cut, partial record, resume", () => {
  const { T, run, progress, ran } = fakeTree();
  let r = run(["--fast", "--budget", "2"], { FAKE_SLEEP_slow: "60", FAKE_SLEEP_mid: "3" });
  expect(r.rc).toBe(75);
  expect(r.out.trim().split("\n").pop()).toMatch(/PARTIAL: 1 of 3 files, run again with --resume$/);
  const rec = JSON.parse(readFileSync(progress, "utf8"));
  expect(rec.mode).toBe("fast");
  expect(rec.files["unit/mid"]).toBe("passed");
  expect(rec.files["unit/slow"]).toBe("not_run");
  expect(rec.files["unit/fast"]).toBe("not_run");

  writeFileSync(join(T, "ran.log"), "");
  r = run(["--resume"]);
  expect(r.rc).toBe(0);
  expect(ran()).not.toContain("unit/mid");
  expect(ran()).toContain("unit/slow");
  expect(existsSync(progress)).toBe(false);

  r = run(["--resume"]);
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/no partial run recorded/);

  writeFileSync(progress, JSON.stringify({ mode: "pick", files: { "unit/fast": "passed", "other/bad": "not_run" } }));
  r = run(["--resume"]);
  expect(r.rc).toBe(1);
  expect(existsSync(progress)).toBe(false);
});

test("full defaults to a 300 s budget, no budget writes no record, bad budget rejected", () => {
  const { run, progress } = fakeTree();
  expect(run(["--full", "unit/fast"]).all).toMatch(/budget: 300s/);
  expect(existsSync(progress)).toBe(false);
  expect(run(["--budget", "x"]).all).toMatch(/whole seconds/);
  const r = run(["slow"], { FAKE_SLEEP_slow: "60", ORCH_TEST_FILE_CAP: "1" });
  expect(r.all).toMatch(/TIMEOUT|FAILED/);
  expect(existsSync(progress)).toBe(false);
});

test("fast tier runs unit only and reports slowest", () => {
  const { run, ran } = fakeTree();
  const r = run([]);
  expect(r.rc).toBe(0);
  expect(ran()).not.toContain("other/bad");
  expect(r.all).toMatch(/slowest:/);
});

// test-budget and test-all: written against scripts/test-budget.ts and scripts/test-all.ts (falls back to .sh until they land).
import { cpSync, chmodSync } from "node:fs";
import { REPO_ROOT } from "../helpers";
const scriptCmd = (dir: string, name: string) => (existsSync(join(dir, "scripts", `${name}.ts`)) ? ["bun", join(dir, "scripts", `${name}.ts`)] : ["bash", join(dir, "scripts", `${name}.sh`)]);
const copyScripts = (to: string) => cpSync(join(REPO_ROOT, "scripts"), join(to, "scripts"), { recursive: true });

test("test-budget: chunks, budget cut, resume, failing chunk", () => {
  const T = tempDir(), B = join(T, "bun");
  mkdirSync(join(B, "src/a"), { recursive: true }); mkdirSync(join(B, "src/node_modules/x"), { recursive: true });
  copyScripts(B);
  for (const n of ["a/one", "a/two", "three", "four"]) writeFileSync(join(B, "src", `${n}.test.ts`), "");
  writeFileSync(join(B, "src/five.test.tsx"), ""); writeFileSync(join(B, "src/node_modules/x/skip.test.ts"), "");
  const fakebin = join(T, "fakebun");
  writeFileSync(fakebin, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const files = process.argv.slice(2);
for (const f of files) {
  appendFileSync("${T}/bun-ran.log", f + "\\n");
  if (f.includes("three")) await Bun.sleep(Number(process.env.FAKE_BUN_SLOW ?? 0) * 1000);
  else if (f.includes("four") && process.env.FAKE_BUN_FAIL) process.exit(1);
}
console.log(" " + files.length + " pass");
`); chmodSync(fakebin, 0o755);
  const progress = join(T, "bun-progress.json");
  const run = (args: string[], extra: Record<string, string> = {}) => runCmd([...scriptCmd(B, "test-budget"), ...args], { cwd: B, env: { ORCH_TEST_LOCK: "0", ORCH_BUN_TEST_CMD: fakebin, ORCH_BUN_TEST_PROGRESS: progress, ORCH_TEST_BUDGET_GRACE: "1", ...extra } });
  let r = run(["--chunk", "1", "--budget", "1"], { FAKE_BUN_SLOW: "60" });
  expect(r.rc).toBe(75);
  expect(r.out.trim().split("\n").pop()).toMatch(/PARTIAL: \d+ of 5 files, run again with --resume$/);
  const rec = readFileSync(progress, "utf8");
  expect(rec).not.toMatch(/skip\.test/);
  expect(rec).toMatch(/"\.\/src\/three\.test\.ts": "not_run"/);
  expect(rec).toMatch(/"\.\/src\/a\/one\.test\.ts": "passed"/);
  writeFileSync(join(T, "bun-ran.log"), "");
  r = run(["--resume"]);
  expect(r.rc).toBe(0);
  const ran = readFileSync(join(T, "bun-ran.log"), "utf8");
  expect(ran).not.toMatch(/a\/one/); expect(ran).toMatch(/three/);
  expect(existsSync(progress)).toBe(false);
  r = run(["--chunk", "2"], { FAKE_BUN_FAIL: "1" });
  expect(r.rc).toBe(1); expect(r.all).toMatch(/bun chunk FAILED.*five.*four/s);
  expect(existsSync(progress)).toBe(false);
}, 120000);

test("test-all: stops at a suite budget once, then resumes", () => {
  const T = tempDir(), A = join(T, "all");
  mkdirSync(join(A, "skills/orch/tests"), { recursive: true });
  copyScripts(A);
  const log = join(T, "all-ran.log");
  writeFileSync(join(A, "skills/orch/tests/run.ts"), `import { appendFileSync } from "node:fs";
const a = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, "bash " + a + "\\n");
if (a.includes("--resume")) { console.log("3 passed, 0 failed"); process.exit(0); }
console.log("1 passed, 0 failed"); console.log("PARTIAL: 1 of 3 files, run again with --resume"); process.exit(75);
`);
  // stub the other suites in place of the real scripts
  const stub = (n: string, body: string) => writeFileSync(join(A, "scripts", `${n}.ts`), `import { appendFileSync } from "node:fs";\nconst log = ${JSON.stringify(log)};\n${body}\n`);
  stub("test-budget", `appendFileSync(log, "bun " + process.argv.slice(2).join(" ") + "\\n"); console.log("bun: 5 passed");`);
  stub("typecheck", `appendFileSync(log, "types\\n"); console.log("typecheck: ok");`);
  stub("lint-optional", `appendFileSync(log, "lint\\n");`);
  const progress = join(T, "all-progress");
  const run = (args: string[] = []) => runCmd([...scriptCmd(A, "test-all"), ...args], { cwd: A, env: { ORCH_TEST_LOCK: "0", ORCH_TEST_ALL_PROGRESS: progress } });
  writeFileSync(log, "");
  let r = run();
  expect(r.rc).toBe(75);
  expect(r.out.trim().split("\n").pop()).toMatch(/PARTIAL: suites left: bash, run again with --resume$/);
  writeFileSync(log, "");
  r = run(["--resume"]);
  expect(r.rc).toBe(0);
  expect(readFileSync(log, "utf8").trim()).toBe("bash --resume");
  expect(existsSync(progress)).toBe(false);
}, 120000);
