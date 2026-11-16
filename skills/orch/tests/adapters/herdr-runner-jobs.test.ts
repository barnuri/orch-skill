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
  const waitJob = (j: string) => d("wait", j, "--timeout", "90", "--interval", "0.2");
  return { root, home, webdir, log, d, env, instCfg, fakeState, waitJob, realhome, shims, fake, calls: () => readText(log) };
};

test("job panes, node tabs, retries, caps, lost panes", async () => {
  const t = setup();
  const { d } = t;
  d("init");
  const job = d.env({ ORCH_HERDR_CLOSE_AFTER: "6", ORCH_TEST_MARKER: "m1" }, "start", "claude", "pane probe").out.trim();
  t.waitJob(job);
  const jd = join(t.home, "jobs", job);
  expect(d("status", job).out.trim()).toBe("done exit=0");
  expect(readText(join(jd, "exit_code")).trim()).toBe("0");
  expect(readText(join(jd, "herdr_pane")).trim()).toBe("w1:p2");
  expect(readText(join(jd, "herdr_sock")).trim()).toMatch(/herdr\.sock$/);
  expect(readText(join(jd, "log"))).toContain(`shim HOME=${t.realhome} marker=m1`);
  expect(readText(join(jd, "herdr-launch.sh"))).not.toMatch(/live-session/);
  expect(readText(join(jd, "herdr-launch.sh"))).toMatch(/exec bun .*\/core\/commands\/herdr-launch\.ts/);
  expect(readText(join(jd, "argv.json"))).toMatch(/"job-run"/);
  expect(t.fakeState().tabs.map((x: any) => x.label).join(" ")).toMatch(new RegExp(`(^|\\] )${job}$`));
  expect(t.fakeState().workspaces.map((w: any) => w.label)).toEqual(["jobs"]);
  expect(t.calls()).not.toMatch(/pane split/);
  await waitUntil(() => t.fakeState().tabs.length === 0, 30);
  expect(t.fakeState().tabs.length).toBe(0);

  writeFileSync(t.log, "");
  d("run", "start", "Herdr run", "--id", "hr-run"); d("node", "add", "hr-run", "a", "a");
  const nj = d.env({ ORCH_HERDR_CLOSE_AFTER: "30", ORCH_TEST_EXIT: "3" }, "node", "dispatch", "hr-run", "a", "claude", "fail probe").out.trim();
  t.waitJob(nj);
  expect(d("status", nj).out.trim()).toBe("done exit=3");
  expect(t.fakeState().workspaces.map((w: any) => w.label)).toEqual(["hr-run"]);
  expect(t.fakeState().tabs.map((x: any) => x.label).join(" ")).toMatch(/(^|\] )a$/);
  const tab = t.fakeState().tabs.find((x: any) => /(^|\] )a$/.test(x.label));
  expect(t.fakeState().panes.filter((p: any) => p.tab_id === tab.tab_id).length).toBe(1);
  expect([(t.calls().match(/tab create/g) ?? []).length, (t.calls().match(/pane split/g) ?? []).length]).toEqual([1, 0]);
  expect(readText(join(t.home, "jobs", nj, "herdr_tab")).trim()).toMatch(/^w\d+:t\d+$/);
  writeFileSync(t.log, "");
  const rj = d.env({ ORCH_RUN_ID: "hr-run", ORCH_NODE_ID: "a", ORCH_NODE_ATTEMPT: "2", ORCH_HERDR_CLOSE_AFTER: "30", ORCH_TEST_EXIT: "0" }, "start", "claude", "retry probe").out.trim();
  t.waitJob(rj);
  expect((t.calls().match(/tab create/g) ?? []).length).toBe(0);
  expect(t.fakeState().tabs.map((x: any) => x.label)).toContain("[1] a #2");
  expect(readText(join(t.home, "jobs", rj, "herdr_tab")).trim()).toBe(readText(join(t.home, "jobs", nj, "herdr_tab")).trim());
  expect(t.fakeState().tabs.length).toBe(1);

  for (const tb of t.fakeState().tabs.map((x: any) => x.tab_id)) Bun.spawnSync(["env", "-i", `PATH=${t.env.PATH}`, `HOME=${join(t.home, "herdr/home")}`, "herdr", "tab", "close", tb]);
  const cap2 = d.env({ ORCH_HERDR_PANE_CAP: "2", ORCH_HERDR_CLOSE_AFTER: "30", ORCH_TEST_EXIT: "1" }, "start", "claude", "cap two").out.trim(); t.waitJob(cap2);
  const cap3 = d.env({ ORCH_HERDR_PANE_CAP: "1", ORCH_HERDR_CLOSE_AFTER: "600", ORCH_TEST_EXIT: "1" }, "start", "claude", "cap three").out.trim(); t.waitJob(cap3);
  expect(existsSync(join(t.home, "jobs", cap2, "herdr_pane"))).toBe(true);
  expect(existsSync(join(t.home, "jobs", cap3, "herdr_pane"))).toBe(false);
  expect(d("status", cap3).out.trim()).toBe("done exit=1");

}, 300000);
