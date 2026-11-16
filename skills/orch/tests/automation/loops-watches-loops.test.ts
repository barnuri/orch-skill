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

test("loop start/stop, watch wait and cursors", async () => {
  const { home, o, loopState } = setup({ claude: TICK });
  expect(o("loop", "start", "--profile", "claude-default", "hi").rc).toBe(2);
  expect(o("loop", "start", "--every", "0s", "--profile", "claude-default", "hi").rc).toBe(2);
  let id = o("loop", "start", "--every", "1s", "--max", "1", "--profile", "claude-default", "hi").out.trim();
  expect(id).toMatch(/^loop-/);
  await until(() => loopState(id).status === "done");
  expect(`${loopState(id).status} ${loopState(id).reason}`).toMatch(/done/);
  expect(o("loop", "tail", id).all).toMatch(/tick/);
  id = o.env({ STOP_LOOP: "1" }, "loop", "start", "--every", "1s", "--profile", "claude-default", "hi").out.trim();
  await until(() => loopState(id).status === "stopped");
  expect(`${loopState(id).status} ${loopState(id).reason}`).toBe("stopped agent");
  expect(o("active").all).toMatch(/no active loops or watches/);
  expect(o("active", "--json").out.trim()).toBe("[]");
  const w = o("watch", "start", "--name", "stream", "printf 'ok\\nFAIL one\\nfine\\nFAIL two\\n'", "--match", "FAIL").out.trim();
  expect(w).toMatch(/^watch-/);
  let r = o("watch", "wait", w, "--timeout", "60", "--max-lines", "1");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/FAIL one/); expect(r.all).not.toMatch(/FAIL two/);
  expect(o("watch", "wait", w, "--timeout", "60").all).toMatch(/FAIL two/);
  expect(o("watch", "wait", w, "--timeout", "60").rc).toBe(3);
  expect(o("watch", "start", "--name", "bad", "--every", "0s", "true").rc).toBe(2);
  expect(o("watch", "start", "--name", "bad", "--on-match", "x", "true").rc).toBe(2);
}, 240000);
