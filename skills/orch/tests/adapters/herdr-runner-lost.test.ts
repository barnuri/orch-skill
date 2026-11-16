import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, fakeHerdrBin, readJson, readText, runState, waitUntil, pidAlive, pathWithout, autoCleanup } from "../helpers";
autoCleanup();

const setup = () => {
  const root = tempDir();
  const fake = fakeHerdrBin();
  const shims = fakeBin({ claude: `printf 'shim HOME=%s marker=%s\\n' "$HOME" "\${ORCH_TEST_MARKER:-none}"\n[ -z "\${ORCH_TEST_SLEEP:-}" ] || sleep "$ORCH_TEST_SLEEP"\nexit "\${ORCH_TEST_EXIT:-0}"` });
  const realhome = join(root, "realhome"), home = join(root, "orch home"), webdir = join(root, "envs.d"), log = join(root, "herdr-calls.log");
  mkdirSync(realhome, { recursive: true }); mkdirSync(home, { recursive: true }); writeFileSync(log, "");
  const env = { HOME: realhome, PATH: `${fake}:${shims}:${process.env.PATH}`, ORCH_HERDR: "1", ORCH_HERDR_FAKE_LOG: log, ORCH_HERDR_CLOSE_AFTER: "1", ORCH_HERDR_START_WAIT: "8", ORCH_HERDR_CALL_TIMEOUT: "40",
    ORCH_HERDR_WEB_ENVS_DIR: webdir, HERDR_SOCKET_PATH: join(realhome, "live-session.sock"), HERDR_ENV: "1", HERDR_PANE_ID: "live:p1", ORCH_RUN_ID: undefined, ORCH_NODE_ID: undefined, ORCH_NODE_ATTEMPT: undefined };
  const d = orch(home, env as any);
  const instCfg = join(home, "herdr/home/.config/herdr");
  const fakeState = () => { try { return readJson(join(instCfg, "fake/state.json")); } catch { return { workspaces: [], tabs: [], panes: [] }; } };
  const waitJob = (j: string) => d("wait", j, "--timeout", "90", "--interval", "0.1");
  return { root, home, webdir, log, d, env, instCfg, fakeState, waitJob, realhome, shims, fake, calls: () => readText(log) };
};

test("lost pane, herdr missing, off and down", async () => {
  const t = setup();
  const { d } = t;
  d("init");
  d("run", "start", "Gone run", "--id", "gone-run"); d("node", "add", "gone-run", "a", "a");
  const gj = d.env({ ORCH_TEST_SLEEP: "60" }, "node", "dispatch", "gone-run", "a", "claude", "die").out.trim();
  await waitUntil(() => existsSync(join(t.home, "jobs", gj, "pid")) && readText(join(t.home, "jobs", gj, "pid")).trim() !== "", 30);
  const gpid = Number(readText(join(t.home, "jobs", gj, "pid")).trim());
  const kids = Bun.spawnSync(["pgrep", "-P", String(gpid)]).stdout.toString().split("\n").filter(Boolean);
  try { process.kill(gpid, "SIGKILL"); } catch {}
  for (const k of kids) try { process.kill(Number(k), "SIGKILL"); } catch {}
  await waitUntil(() => !pidAlive(gpid), 5);
  d("run", "sync", "gone-run", "--no-retry");
  expect(runState(t.home, "gone-run").nodes[0].status).toBe("error");
  expect(readText(join(t.home, "runs/gone-run/events.jsonl"))).toMatch(/"kind":"note".*"node":"a".*pane w\d+:p\d+ is gone/);
  const own = t.calls().split("\n").filter((l) => !/:: pane get live:p1$/.test(l)).join("\n");
  const bad = own.split("\n").filter((l) => l && !l.includes(`HOME=${join(t.home, "herdr/home")}`) && !l.includes("HOME=/tmp/orch-herdr-")).length;
  expect(bad).toBe(0);
  expect(own).not.toMatch(/socketenv=.+ ::/);
  expect(own).not.toMatch(/live-session|realhome/);

  writeFileSync(t.log, "");
  const nopath = pathWithout("herdr");
  const miss = orch(t.home, { ...t.env, PATH: `${t.shims}:${nopath}` })("start", "claude", "missing").out.trim();
  d("wait", miss, "--timeout", "90", "--interval", "0.1");
  expect(d("status", miss).out.trim()).toBe("done exit=0");
  expect(existsSync(join(t.home, "jobs", miss, "herdr_pane"))).toBe(false);
  expect(orch(t.home, { ...t.env, PATH: `${t.shims}:${nopath}` })("herdr", "status").all).toMatch(/herdr not on PATH/);
  const off = d.env({ ORCH_HERDR: "0" }, "start", "claude", "off").out.trim(); t.waitJob(off);
  expect(existsSync(join(t.home, "jobs", off, "herdr_pane"))).toBe(false);
  d("herdr", "stop");
  const down = d.env({ ORCH_HERDR_FAKE_DOWN: "1", ORCH_HERDR_START_WAIT: "1" }, "start", "claude", "unreachable").out.trim(); t.waitJob(down);
  expect(d("status", down).out.trim()).toBe("done exit=0");
  expect(existsSync(join(t.home, "jobs", down, "herdr_pane"))).toBe(false);
  d("herdr", "stop");
}, 300000);
