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

test("announce: dry-run, big runs, real run, clear, loop states", () => {
  let t: ReturnType<typeof mk>;
  t = mk(); seedRun(t.O);
  const d = t.ann("--dry-run").out;
  expect(d).toMatch(/report-metadata p1 .*--ttl-ms 120000/); expect(d).toMatch(/file: .*activity\/sess1.json/);
  expect((t.callsText().match(/report-metadata/g) ?? []).length).toBe(0);
  expect(existsSync(join(t.O, "activity"))).toBe(false);
  expect(t.ann("--dry-run", "--quiet").out).toBe("");
  t = mk(); mkdirSync(join(t.O, "runs/big"), { recursive: true });
  writeFileSync(join(t.O, "runs/big/state.json"), JSON.stringify({ status: "running", coordinator: { session_id: "sess1" }, nodes: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, status: "running" })) }));
  t.ann("--quiet");
  expect(readJson(join(t.O, "activity/sess1.json")).summary.length).toBeLessThan(1000);
  t = mk();
  const o = orch(t.O); o("init");
  const R = o("run", "start", "real").out.trim();
  o("node", "add", R, "a", "A"); o("node", "add", R, "b", "B"); o("node", "update", R, "a", "running"); o("node", "update", R, "a", "done"); o("node", "update", R, "b", "running");
  t.ann("--quiet", "--run", R);
  expect(readText(join(t.O, "activity/sess1.json"))).toMatch(/orch: 1 running, 1\/2 done/);
  t = mk(); seedRun(t.O); t.ann("--quiet", "--clear");
  expect(readText(join(t.O, "activity/sess1.json"))).toMatch(/"active":false/);
  t = mk(); seedRun(t.O);
  const lp = Bun.spawn(["sleep", "900"]);
  seedState(t.O, "loops", "live", "running", lp.pid);
  for (const st of ["stopped", "done", "failed"]) seedState(t.O, "loops", st, st, lp.pid);
  seedState(t.O, "loops", "dead", "running", 999999);
  t.ann("--quiet");
  expect(readJson(join(t.O, "activity/sess1.json")).summary).toBe("orch: 2 running, 1/4 done · 1 loop");
  lp.kill();
}, 120000);
