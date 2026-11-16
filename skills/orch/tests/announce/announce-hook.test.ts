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

test("announce hook from dispatch and daemon", async () => {
  const t = mk();
  const base = { ...t.env, ANNOUNCE_NO_DAEMON: undefined as any };
  const hk = (...a: string[]) => runCmd(["bun", DISPATCH, ...a], { env: { ...base } });
  runCmd(["bun", DISPATCH, "init"], { env: { ...base, ORCH_NO_ANNOUNCE: "1" } });
  const R = hk("run", "start", "hook").out.trim();
  runCmd(["bun", DISPATCH, "run", "set", R, "coordinator"], { env: { ...base, ORCH_NO_ANNOUNCE: "1", HERDR_SOCKET_PATH: join(t.H, "none.sock") } });
  await waitUntil(() => t.callsText().includes("report-metadata"), 10);
  expect(t.callsText()).toMatch(/report-metadata p1/);
  hk("node", "add", R, "a", "A"); await Bun.sleep(300); writeFileSync(t.calls, "");
  writeFileSync(join(t.O, ".announce-ts"), `${Math.floor(Date.now() / 1000) + 60}\n`);
  expect(hk("node", "update", R, "a", "running").rc).toBe(0);
  await Bun.sleep(500);
  expect((t.callsText().match(/report-metadata/g) ?? []).length).toBe(0);
  writeFileSync(join(t.O, ".announce-ts"), `${Math.floor(Date.now() / 1000) - 10}\n`);
  hk("node", "ping", R, "a", "--note", "x");
  await waitUntil(() => t.callsText().includes("report-metadata"), 10);
  expect(t.callsText()).toMatch(/orch: 1 running/);
  await waitUntil(() => /started/.test(readText(join(t.O, "announce.log"))), 20);
  const dpid = Number(readText(join(t.O, "announce.pid")));
  runCmd(["bun", DISPATCH, "announce", "--clear", "--quiet"], { env: { ...base } });
  await waitUntil(() => !pidAlive(dpid), 20);
  writeFileSync(t.calls, ""); writeFileSync(join(t.O, ".announce-ts"), "0\n");
  runCmd(["bun", DISPATCH, "node", "ping", R, "a", "--note", "y"], { env: { ...base, ORCH_NO_ANNOUNCE: "1" } });
  await Bun.sleep(600);
  expect((t.callsText().match(/report-metadata/g) ?? []).length).toBe(0);
  runCmd(["bun", DISPATCH, "node", "ping", R, "a", "--note", "z"], { env: { ...base, HERDR_ENV: undefined, HERDR_PANE_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined, OPENCODE_SESSION_ID: undefined } });
  await Bun.sleep(600);
  expect((t.callsText().match(/report-metadata/g) ?? []).length).toBe(0);
  expect(runCmd(["bun", DISPATCH, "announce", "--dry-run"], { env: { ...base } }).out).toMatch(/orch: 1 running/);
}, 120000);
