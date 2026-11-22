import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orch, seedHome, waitUntil, cleanEnv, DISPATCH, autoCleanup } from "../helpers";
autoCleanup();

const base = { ORCH_WAIT_POLL_SECS: "0.1", ORCH_WAIT_HEALTH_SECS: "1", ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_CACHE_SECS: "0", ORCH_NO_DONE_GATE: "1" };

test("run watch: prints each event and exits 0 when the run ends", async () => {
  const home = seedHome();
  const o = orch(home, base);
  const R = o("run", "start", "watch run").out.trim();
  o("node", "add", R, "a", "A");
  const outFile = join(home, "watch.out");
  const w = Bun.spawn(["bun", DISPATCH, "run", "watch", R], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ...base }), stdout: Bun.file(outFile), stderr: "pipe" });
  await waitUntil(() => existsSync(join(home, "runs", R, "wait.cursor")), 90);
  o("node", "update", R, "a", "running", "--owner", "coordinator");
  await waitUntil(() => readFileSync(outFile, "utf8").includes("a waiting->running"), 90);
  o("run", "finish", R, "--status", "cancelled");
  const code = await w.exited;
  expect(code).toBe(0);
  expect(readFileSync(outFile, "utf8")).toMatch(/run ended: cancelled/);
});


test("run watch: a run that already ended exits 0 at once", () => {
  const home = seedHome();
  const o = orch(home, base);
  const R = o("run", "start", "ended run").out.trim();
  o("run", "finish", R, "--status", "cancelled");
  expect(o("run", "watch", R).rc).toBe(0);
});

test("run watch: mailbox message appears in target inbox on the next watch pass", async () => {
  const home = seedHome();
  const o = orch(home, base);
  const R = o("run", "start", "mailbox watch", "--id", "mail-watch").out.trim();
  o("node", "add", R, "target", "Target node");
  o("msg", "send", R, "--to", "target", "--from", "orch", "deliver this");
  const outFile = join(home, "mailbox-watch.out");
  const w = Bun.spawn(["bun", DISPATCH, "run", "watch", R], { env: cleanEnv({ HARNESS_ORCH_HOME: home, ...base }), stdout: Bun.file(outFile), stderr: "pipe" });
  await waitUntil(() => existsSync(join(home, "runs", R, "out", "target", "inbox.md")), 90);
  o("run", "finish", R, "--status", "cancelled");
  expect(await w.exited).toBe(0);
  expect(readFileSync(join(home, "runs", R, "out", "target", "inbox.md"), "utf8")).toContain("deliver this");
});

test("run watch: unknown run exits 2", () => {
  const home = seedHome();
  expect(orch(home, base)("run", "watch", "nope-run").rc).toBe(2);
});
