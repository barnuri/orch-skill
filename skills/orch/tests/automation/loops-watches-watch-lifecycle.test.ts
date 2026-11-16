import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readJson, readText, editJson, runState, waitUntil, pidAlive, autoCleanup } from "../helpers";
autoCleanup();

const setup = (shims: Record<string, string>, env: Record<string, string> = {}) => {
  const home = seedHome();
  const bin = fakeBin(shims);
  const o = orch(home, { PATH: `${bin}:${process.env.PATH}`, ORCH_EVERY_MIN_SECS: "1", ...env });
  const loopState = (id: string) => readJson(join(home, "loops", id, "state.json"));
  const watchState = (id: string) => readJson(join(home, "watches", id, "state.json"));
  const ws = (id: string) => `${watchState(id).status} ${watchState(id).reason ?? ""}`;
  return { home, bin, o, loopState, watchState, ws };
};
const until = (f: () => boolean, s = 60) => waitUntil(() => { try { return f(); } catch { return false; } }, s);
const TICK = `echo "tick"\n[ -n "\${STOP_LOOP:-}" ] && echo STOP > "$ORCH_LOOP_CONTROL"\nexit 0`;

test("watch lifecycle: TERM, dead, reused pid, restarts", async () => {
  const { home, o, watchState, ws } = setup({ claude: 'echo "ok"' });
  let w = o("watch", "start", "--name", "sig", "--every", "10s", "echo hi").out.trim();
  await until(() => readText(join(home, "watches", w, "events.jsonl")).length > 0, 20);
  process.kill(watchState(w).pid, "SIGTERM");
  await until(() => watchState(w).status === "stopped", 20);
  expect(ws(w)).toBe("stopped signal TERM");
  w = o("watch", "start", "--name", "killed", "--every", "10s", "echo hi").out.trim();
  let wpid = watchState(w).pid;
  try { process.kill(-wpid, "SIGKILL"); } catch {}
  await until(() => !pidAlive(wpid), 10);
  expect(ws(w)).toMatch(/^running/);
  expect(o("watch", "list").out).toContain(`${w}\tdead`);
  expect(ws(w)).toMatch(/^dead process \d+ gone/);
  expect(readText(join(home, "watches", w, "events.jsonl")).trim().split("\n").pop()).toMatch(/"kind":"lifecycle"/);
  expect(o("active", "--json").out).not.toContain(w);
  const other = Bun.spawn(["sleep", "300"]);
  w = o("watch", "start", "--name", "reused", "--every", "10s", "echo hi").out.trim();
  try { process.kill(-watchState(w).pid, "SIGKILL"); } catch {}
  editJson(join(home, "watches", w, "state.json"), (s) => { s.pid = other.pid; });
  expect(o("active", "--json").out).not.toContain(w);
  expect(ws(w)).toMatch(/^dead pid \d+ now belongs to another process$/);
  const w2 = o("watch", "start", "--name", "reused2", "--every", "10s", "echo hi").out.trim();
  try { process.kill(-watchState(w2).pid, "SIGKILL"); } catch {}
  editJson(join(home, "watches", w2, "state.json"), (s) => { s.pid = other.pid; });
  o("watch", "stop", w2);
  expect(pidAlive(other.pid)).toBe(true);
  other.kill();
  const liveRun = o("run", "start", "live").out.trim(), overRun = o("run", "start", "over").out.trim();
  const wLive = o("watch", "start", "--name", "live", "--every", "10s", `echo ${liveRun}`).out.trim();
  const wOver = o("watch", "start", "--name", "over", "--every", "10s", `echo ${overRun}`).out.trim();
  const wUser = o("watch", "start", "--name", "user", "--every", "10s", "echo hi").out.trim();
  await until(() => [wLive, wOver, wUser].every((x) => readText(join(home, "watches", x, "events.jsonl")).length > 0), 30);
  o("watch", "stop", wUser); o("run", "finish", overRun);
  const oldPid = watchState(wLive).pid;
  const killed = [wLive, wOver].map((x) => watchState(x).pid);
  for (const p of killed) try { process.kill(-p, "SIGKILL"); } catch {}
  for (const p of killed) await until(() => !pidAlive(p), 10);
  o("sync", "--no-serve");
  const np = watchState(wLive).pid;
  expect(ws(wLive)).toMatch(/^running/);
  expect(np).not.toBe(oldPid); expect(pidAlive(np)).toBe(true);
  expect(readText(join(home, "watches", wLive, "events.jsonl"))).toMatch(/restarted \(was dead: process \d+ gone/);
  expect(o("watch", "list").out).toContain(`${wLive}\trunning`);
  expect(ws(wOver)).toMatch(/^dead /);
  expect(ws(wUser)).toBe("stopped stopped");
  o("watch", "stop", wLive);
}, 240000);
