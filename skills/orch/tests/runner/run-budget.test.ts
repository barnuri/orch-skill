import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { TESTS_DIR, tempDir, runCmd, autoCleanup } from "../helpers";
autoCleanup();

// Fake tree: three unit files (slow, mid, fast) and one failing file elsewhere.
function fakeTree() {
  const T = tempDir();
  const tests = join(T, "skills/orch/tests");
  mkdirSync(join(tests, "unit"), { recursive: true });
  mkdirSync(join(tests, "other"), { recursive: true });
  mkdirSync(join(tests, "helpers"), { recursive: true });
  copyFileSync(join(TESTS_DIR, "run.ts"), join(tests, "run.ts"));
  for (const n of ["slow", "mid", "fast"]) {
    writeFileSync(join(tests, "unit", `${n}.test.ts`), `import {test} from "bun:test";
import {appendFileSync} from "node:fs";
test("${n}", async () => { appendFileSync(${JSON.stringify(join(T, "ran.log"))}, "unit/${n}\\n"); await Bun.sleep(Number(process.env.FAKE_SLEEP_${n} ?? 0) * 1000); });\n`);
  }
  writeFileSync(join(tests, "other/bad.test.ts"), `import {test,expect} from "bun:test";
import {appendFileSync} from "node:fs";
test("bad", () => { appendFileSync(${JSON.stringify(join(T, "ran.log"))}, "other/bad\\n"); expect(1).toBe(2); });\n`);
  writeFileSync(join(T, "timings.json"), JSON.stringify({ "unit/slow": 50, "unit/mid": 10, "unit/fast": 5, "other/bad": 1 }));
  const env = { ORCH_TEST_TIMINGS: join(T, "timings.json"), ORCH_TEST_PROGRESS: join(T, "progress.json"), ORCH_TEST_BUDGET_GRACE: "3", ORCH_TEST_JOBS: "2" };
  const run = (args: string[], extra: Record<string, string> = {}) => runCmd(["bun", join(tests, "run.ts"), ...args], { env: { ...env, ...extra } });
  return { T, run, progress: join(T, "progress.json"), ran: () => (existsSync(join(T, "ran.log")) ? readFileSync(join(T, "ran.log"), "utf8") : "") };
}

test("budget cut, partial record, resume", () => {
  const { T, run, progress, ran } = fakeTree();
  let r = run(["--fast", "--budget", "2"], { FAKE_SLEEP_slow: "60", FAKE_SLEEP_mid: "3" });
  expect(r.rc).toBe(75);
  expect(r.all.trim().split("\n").pop()).toMatch(/PARTIAL: 1 of 3 files, run again with --resume$/);
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
  expect(r.all).toMatch(/TIMEOUT/);
  expect(existsSync(progress)).toBe(false);
});

test("fast tier runs unit only and reports slowest", () => {
  const { run, ran } = fakeTree();
  const r = run([]);
  expect(r.rc).toBe(0);
  expect(ran()).not.toContain("other/bad");
  expect(r.all).toMatch(/slowest:/);
});
