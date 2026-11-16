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

test("loop sessions, runtime, lost loops", async () => {
  const { home, o, loopState } = setup({ claude: `echo "sess=\${ORCH_SESSION_ID:-} resume=\${ORCH_RESUME_SESSION:-}"\nexit "\${SHIM_EXIT:-0}"` });
  expect(o("loop", "start", "--every", "1s", "--session", "resume", "opencode", "x").rc).toBe(2);
  expect(o("loop", "start", "--every", "1s", "--max-runtime", "nope", "--profile", "claude-default", "x").rc).toBe(2);
  let id = o("loop", "start", "--every", "1s", "--max", "2", "--session", "resume", "--profile", "claude-default", "x").out.trim();
  await until(() => loopState(id).status === "done");
  const l1 = readText(join(home, "loops", id, "iter-1.log")), l2 = readText(join(home, "loops", id, "iter-2.log"));
  expect(l1).toMatch(/^sess=[0-9a-f-]{36} resume=$/m);
  expect(l2).toMatch(/^sess= resume=[0-9a-f-]{36}$/m);
  expect(l2).toContain(l1.match(/^sess=(.*) resume=$/m)![1]);
  id = o("loop", "start", "--every", "1s", "--max-runtime", "2s", "--profile", "claude-default", "x").out.trim();
  await until(() => loopState(id).status === "done");
  expect(`${loopState(id).status} ${loopState(id).reason}`).toMatch(/done max-runtime/);
  expect(o("loop", "resume", id).rc).toBe(2);
  id = o("loop", "start", "--every", "1s", "--profile", "claude-default", "x").out.trim();
  await until(() => loopState(id).iteration === 1);
  try { process.kill(loopState(id).pid, "SIGKILL"); } catch {}
  await until(() => /lost/.test(o("loop", "list").out.split("\n").find((l) => l.includes(id)) ?? ""));
  expect(o("loop", "list").out).toMatch(/lost/);
  expect(o("active", "--json").out).toMatch(/"status":"lost"/);
  o("sync", "--no-serve");
  await until(() => /running/.test(o("loop", "list").out.split("\n").find((l) => l.includes(id)) ?? ""));
  expect(o("loop", "list").out.split("\n").find((l) => l.includes(id))).toMatch(/running/);
  o("loop", "stop", id);
  expect(o("loop", "resume", id).rc).toBe(0);
  o("loop", "stop", id);
}, 240000);
