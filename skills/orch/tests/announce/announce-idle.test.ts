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

test("announce: idle, counts, filters, no-ops", () => {
  let t = mk();
  expect(t.ann("--quiet").rc).toBe(0);
  expect(readText(join(t.O, "activity/sess1.json"))).toMatch(/"active":false/);
  expect(t.callsText()).toMatch(/clear-state-labels.*clear-token orch/);
  expect(readText(join(t.H, ".claude/workflow-active/sess1"))).toMatch(/"active":false/);

  t = mk(); seedRun(t.O);
  const live = Bun.spawn(["sleep", "900"]);
  seedState(t.O, "loops", "l1", "running", live.pid); seedState(t.O, "loops", "l2", "running", 999999);
  seedState(t.O, "watches", "w1", "running", live.pid); seedState(t.O, "watches", "w2", "running", live.pid);
  t.ann("--quiet", "--ttl-sec", "45");
  const j = readText(join(t.O, "activity/sess1.json"));
  expect(j).toMatch(/"running":2,"done":1,"total":4/);
  expect(j).toMatch(/orch: 2 running, 1\/4 done · 1 loop · 2 monitors/);
  expect(JSON.parse(j).summary).not.toContain("loops");
  const c = t.callsText();
  expect(c).toMatch(/ttl-ms 45000/); expect(c).toMatch(/--agent opencode/); expect(c).toMatch(/--source user:orch/);
  expect((c.match(/report-agent/g) ?? []).length).toBe(0);
  expect((statSync(join(t.O, "activity/sess1.json")).mode & 0o777).toString(8)).toBe("600");
  expect(readdirSync(join(t.O, "activity")).filter((f) => f.startsWith(".tmp")).length).toBe(0);
  expect(readText(join(t.H, ".claude/workflow-active/sess1"))).toMatch(/"active":true/);
  live.kill();

}, 120000);
