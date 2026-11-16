import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { orch, seedHome, tempDir, readText, readJson, runCmd, DISPATCH, cleanEnv, opencodeFixture, waitUntil, autoCleanup } from "../helpers";
autoCleanup();
const base = { ORCH_WAIT_POLL_SECS: "0.1", ORCH_WAIT_HEALTH_SECS: "1", ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_CACHE_SECS: "0" };
const spawnWait = (home: string, env: Record<string, string>, ...args: string[]) =>
  Bun.spawn(["bun", DISPATCH, "run", "wait", ...args], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ...env }), stdout: "pipe", stderr: "pipe" });
const afterCursor = (home: string, R: string, fn: () => void) => (async () => { await waitUntil(() => existsSync(join(home, "runs", R, "wait.cursor")), 90); fn(); })();

test("wait: stall and dead owners, argument errors", async () => {
  const fx = await opencodeFixture();
  const home = seedHome();
  const o = orch(home, { ...base, ...fx.env, ORCH_OWNER_FILL: "0", ORCH_SQLITE3: join(fx.dir, "no-sqlite3") });
  const S = o("run", "start", "stall").out.trim();
  for (const n of ["ok", "st", "dg"]) o("node", "add", S, n, n);
  o("node", "update", S, "ok", "running", "--owner", "ses_busy1");
  o("node", "update", S, "st", "running", "--owner", "ses_stall1");
  o("node", "update", S, "dg", "running", "--owner", "ses_gone99");
  let r = o("run", "wait", S, "--timeout", "60", "--stall-min", "60");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^dg dead: session ses_gone99 is gone$/m);
  expect(r.out).not.toMatch(/^st stalled/m);
  r = o("run", "wait", S, "--timeout", "60");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^st stalled: no activity since \d{2}:\d{2}$/m);
  expect(r.out).not.toMatch(/^ok /m);
  r = o("run", "wait", S, "--timeout", "1", "--json");
  expect(r.rc).toBe(124);
  expect(r.out).toMatch(/"kind":"timeout"/);
  expect(o("run", "wait", S, "--stall-min", "0").rc).toBe(2);
  expect(o("run", "wait", S, "--bogus").rc).toBe(2);
  expect(o("run", "wait", S, "--timeout", "x").rc).toBe(2);
  expect(o("run", "wait", S, "r2").rc).toBe(2);
  expect(o("run", "wait").rc).toBe(2);
}, 300000);

