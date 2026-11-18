import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { orch, seedHome, tempDir, readText, readJson, runCmd, DISPATCH, cleanEnv, opencodeFixture, waitUntil, autoCleanup } from "../helpers";
autoCleanup();
const base = { ORCH_WAIT_POLL_SECS: "0.1", ORCH_WAIT_HEALTH_SECS: "1", ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_CACHE_SECS: "0" };
const spawnWait = (home: string, env: Record<string, string>, ...args: string[]) =>
  Bun.spawn(["bun", DISPATCH, "run", "wait", ...args], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ...env }), stdout: "pipe", stderr: "pipe" });
const afterCursor = (home: string, R: string, fn: () => void) => (async () => { await waitUntil(() => existsSync(join(home, "runs", R, "wait.cursor")), 90); fn(); })();

test("wait: change, timeout, needs-user, follow --json", async () => {
  const home = seedHome();
  const wenv = { ...base, ORCH_OPENCODE_DB: join(tempDir(), "none.db"), ORCH_OWNER_FILL: "0" };
  const o = orch(home, wenv);
  const ow = async (...args: string[]) => {
    const p = spawnWait(home, wenv, ...args);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { rc: await p.exited, out, err, all: out + err };
  };
  const R = o("run", "start", "wait").out.trim();
  o("node", "add", R, "a", "A"); o("node", "add", R, "b", "B", "--after", "a"); o("node", "add", R, "w", "W");
  o("node", "update", R, "a", "running", "--owner", "coordinator"); o("node", "update", R, "w", "running", "--owner", "coordinator");
  const p = afterCursor(home, R, () => o("node", "update", R, "a", "done"));
  let r = await ow(R, "--timeout", "60");
  await p;
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^a running->done \[unknown\]$/m);
  expect(r.out).toMatch(/^ready: b$/m);
  r = await ow(R, "--timeout", "1");
  expect(r.rc).toBe(124);
  expect(r.out).toMatch(/^no change/m);
  o("node", "update", R, "b", "running", "--owner", "coordinator");
  o("run", "wait", R, "--timeout", "5");
  o("node", "add", R, "q", "Q");
  o("run", "wait", R, "--timeout", "5");
  const p2 = afterCursor(home, R, () => o("node", "update", R, "q", "--needs-user", "pick a database"));
  r = await ow(R, "--timeout", "60");
  await p2;
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^q needs-user: pick a database$/m);
  expect(r.out.replace(/\n/g, " ")).not.toMatch(/needs-user.*needs-user/);
  expect(o("run", "wait", R, "--timeout", "1").rc).toBe(124);

  const proc = spawnWait(home, { ...base, ORCH_OWNER_FILL: "0" }, R, "--follow", "--json", "--timeout", "120");
  const text = new Response(proc.stdout).text();
  await waitUntil(() => existsSync(join(home, "runs", R, "wait.follow.cursor")), 60);
  o("node", "update", R, "w", "done");
  await Bun.sleep(500);
  o("node", "update", R, "b", "error", "--error", "boom");
  await Bun.sleep(500);
  o("node", "update", R, "q", "--clear-needs-user"); o("node", "update", R, "q", "skipped");
  o("run", "finish", R, "--status", "done", "--force", "--reason", "test");
  expect(await proc.exited).toBe(0);
  const log = await text;
  expect(log).toMatch(/"kind":"status","node":"w","from":"running","to":"done"/);
  expect(log).toMatch(/"node":"b".*"to":"error","note":"boom"/);
  expect(log).toMatch(/"kind":"run-ended"/);
  const lines = log.trim().split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(lines.every((l) => { const j = JSON.parse(l); return "kind" in j && "run" in j; })).toBe(true);
}, 300000);

