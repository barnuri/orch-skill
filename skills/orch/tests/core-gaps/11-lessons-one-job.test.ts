import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { runHome, setNode } from "./common";
import { fakeBin, autoCleanup, runCmdAsync, DISPATCH, tempDir, waitUntil } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

const exited = (home: string, job: string): boolean => { try { return readFileSync(join(home, "jobs", job, "exit_code"), "utf8").trim() !== ""; } catch { return false; } };
const finish = async (home: string, job: string): Promise<void> => void expect(await waitUntil(() => exited(home, job), 30)).toBe(true);
const log = (home: string, job: string) => readFileSync(join(home, "jobs", job, "log"), "utf8");
const lastLine = (s: string) => s.trim().split("\n").pop()!;
const jobsOf = (home: string, node: string) =>
  readdirSync(join(home, "jobs")).filter((j) => { try { return readFileSync(join(home, "jobs", j, "node"), "utf8").trim() === node; } catch { return false; } });

// P20: one live job per node.
test("P20 three concurrent dispatches of one node create exactly one job", async () => {
  const done = join(tempDir("orch-p20-"), "done");
  const bin = fakeBin({ claude: `while [ ! -f "$ORCH_TEST_DONE" ]; do sleep 0.1; done\necho ok` });
  const env = { PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_DONE: done };
  const t = runHome(env);
  const rs = await Promise.all([1, 2, 3].map(() => runCmdAsync([process.execPath, DISPATCH, "node", "dispatch", "r1", "a", "claude", "TASK"], { home: t.home, env })));
  expect(rs.filter((r) => r.rc === 0)).toHaveLength(1);
  expect(jobsOf(t.home, "r1/a")).toHaveLength(1);
  expect(t.node("a").status).toBe("running");
  expect(t.node("a").job_id).toBe(jobsOf(t.home, "r1/a")[0]);

  // A node reset to waiting while its job still lives: dispatch refuses without --force, and allows it with.
  t.o("node", "update", "r1", "a", "waiting", "--force");
  const refused = t.o("node", "dispatch", "r1", "a", "claude", "TASK");
  expect(refused.rc).toBe(2);
  expect(refused.err).toMatch(/already has live job/);
  expect(jobsOf(t.home, "r1/a")).toHaveLength(1);
  const forced = t.o("node", "dispatch", "r1", "a", "claude", "TASK", "--force");
  expect(forced.rc).toBe(0);
  expect(jobsOf(t.home, "r1/a")).toHaveLength(2);

  // retry (what the watchdog runs) refuses while a job lives; --force overrides.
  t.o("node", "update", "r1", "a", "error", "--force", "--error", "process died");
  const retry = t.o("node", "retry", "r1", "a");
  expect(retry.rc).toBe(2);
  expect(retry.err).toMatch(/already has live job/);
  writeFileSync(done, "x");
  expect(await waitUntil(() => jobsOf(t.home, "r1/a").every((j) => exited(t.home, j)), 30)).toBe(true);
});

test("P20 two concurrent retries of one errored node create exactly one job", async () => {
  const done = join(tempDir("orch-p20-"), "done");
  const bin = fakeBin({ claude: `while [ ! -f "$ORCH_TEST_DONE" ]; do sleep 0.1; done\necho ok` });
  const env = { PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_DONE: done };
  const t = runHome(env);
  setNode(t.home, "a", { prompt: "TASK", profile: null, adapter: "claude" });
  t.o("node", "update", "r1", "a", "error", "--force", "--error", "process died");
  const rs = await Promise.all([1, 2].map(() => runCmdAsync([process.execPath, DISPATCH, "node", "retry", "r1", "a"], { home: t.home, env })));
  expect(rs.filter((r) => r.rc === 0)).toHaveLength(1);
  expect(jobsOf(t.home, "r1/a")).toHaveLength(1);
  expect(t.node("a").attempts).toHaveLength(1);
  expect(t.node("a").status).toBe("running");
  writeFileSync(done, "x");
  await finish(t.home, jobsOf(t.home, "r1/a")[0]!);
});
