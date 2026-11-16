import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readJson, readText, runCmd, DISPATCH, ORCH_DIR, cleanEnv, waitUntil, pidAlive, autoCleanup } from "../helpers";
autoCleanup();

// The announcer is driven through its dispatch subcommand (`dispatch.sh announce`) with a fake herdr.
const mk = (herdrTail = "exit 0", agent = "opencode") => {
  const T = tempDir(), H = join(T, "home"), O = join(T, "orch");
  mkdirSync(H, { recursive: true }); mkdirSync(O, { recursive: true });
  const calls = join(T, "calls"); writeFileSync(calls, "");
  const fake = fakeBin({ herdr: `printf "%s\\n" "$*" >> "${calls}"\nif [ "$1 $2" = "pane current" ]; then echo '{"result":{"pane":{"agent":"${agent}"}}}'; fi\n${herdrTail}` });
  const env = { HOME: H, HARNESS_ORCH_HOME: O, HERDR_ENV: "1", HERDR_PANE_ID: "p1", HERDR_BIN_PATH: join(fake, "herdr"), CLAUDE_CODE_SESSION_ID: "sess1", ANNOUNCE_NO_DAEMON: "1", ORCH_NO_ANNOUNCE: undefined as any };
  const ann = (...a: string[]) => runCmd(["bun", DISPATCH, "announce", ...a], { env });
  return { T, H, O, calls, fake, env, ann, callsText: () => readText(calls) };
};
const seedRun = (O: string) => { mkdirSync(join(O, "runs/r1"), { recursive: true }); writeFileSync(join(O, "runs/r1/state.json"), JSON.stringify({ run_id: "r1", status: "running", coordinator: { session_id: "sess1" }, nodes: [{ id: "a", status: "done" }, { id: "b", status: "running" }, { id: "c", status: "running" }, { id: "d", status: "waiting" }] })); };
const seedState = (O: string, dir: string, name: string, status: string, pid: number) => { mkdirSync(join(O, dir, name), { recursive: true }); writeFileSync(join(O, dir, name, "state.json"), JSON.stringify({ status, pid, run_id: "r1" })); };

test("announce: filters, clear and loop states", () => {
  let t: ReturnType<typeof mk>;
  t = mk(); seedRun(t.O); t.ann("--quiet", "--run", "nope");
  expect(readText(join(t.O, "activity/sess1.json"))).toMatch(/"active":false/);
  t = mk(); seedRun(t.O);
  runCmd(["bun", DISPATCH, "announce", "--quiet"], { env: { ...t.env, HERDR_ENV: undefined, HERDR_PANE_ID: undefined, CLAUDE_CODE_SESSION_ID: "s" } });
  expect(t.callsText().trim()).toBe("");
  t = mk("exit 3"); seedRun(t.O); expect(t.ann("--quiet").rc).toBe(0);
  t = mk("exec sleep 20"); seedRun(t.O);
  const s = Date.now();
  const r = runCmd(["bun", DISPATCH, "announce", "--quiet"], { env: { ...t.env, ANNOUNCE_HERDR_TIMEOUT: "1" } });
  expect(r.rc).toBe(0); expect((Date.now() - s) / 1000).toBeLessThan(30);
}, 120000);
