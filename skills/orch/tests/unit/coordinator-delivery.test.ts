import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120000);
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readJson, readText, editJson, writeJson, runState, autoCleanup, trashSync } from "../helpers";
autoCleanup();

// Fake herdr (TypeScript, run by bun): logs calls, answers pane get/list/read, records send-text.
const FAKE = `#!/bin/sh
echo "\${HERDR_SOCKET_PATH:-} $*" >> "$FAKE_LOG"
mode() { [ -e "$FAKE_FLAGS/$1" ]; }
case "$1 $2" in
"pane get")
  if mode gone; then exit 1; fi
  if [ -f "$FAKE_FLAGS/gone_pane" ] && [ "$(tr -d ' \\n' < "$FAKE_FLAGS/gone_pane")" = "$3" ]; then exit 1; fi
  f="$FAKE_GETS/$3.json"
  if [ -f "$f" ]; then
    if mode working; then sed 's/"agent_status": *"[^"]*"/"agent_status":"working"/; s/}$/,"agent_status":"working"}/' "$f"; else cat "$f"; fi
  elif mode working; then echo '{"agent_status":"working"}'; else echo '{"agent_status":"idle"}'; fi ;;
"pane list") [ -f "$FAKE_LIST" ] && cat "$FAKE_LIST" ;;
"pane read")
  mode read_fail && exit 1
  mode changing && od -An -N8 -tx1 /dev/urandom
  echo output
  if mode typing; then echo "❯ half a draft"; else echo "❯"; fi ;;
"pane send-text") mode send_fail && exit 1; printf '%s\\n' "$4" >> "$FAKE_TEXT" ;;
esac
exit 0
`;

const setup = () => {
  const home = seedHome();
  const dir = tempDir("orch-coord-");
  const flags = join(dir, "flags"), gets = join(dir, "gets");
  mkdirSync(flags); mkdirSync(gets);
  const fake = fakeBin({ herdr: FAKE });
  const log = join(dir, "fake.log"), text = join(dir, "fake.text"), list = join(dir, "list.json");
  writeFileSync(log, ""); writeFileSync(text, "");
  const repo = join(dir, "repo"); mkdirSync(repo);
  const sock = join(dir, "coord.sock"); writeFileSync(sock, "");
  const env = { PATH: `${fake}:${process.env.PATH}`, FAKE_LOG: log, FAKE_TEXT: text, FAKE_FLAGS: flags, FAKE_GETS: gets, FAKE_LIST: list, ORCH_COORD_SETTLE_SECS: "0", ORCH_OWNER_INDEX: "0", ORCH_HERDR: "0", HOME: join(dir, "home") };
  mkdirSync(join(dir, "home/.config/herdr"), { recursive: true });
  const o = orch(home, env);
  mkdirSync(join(home, "runs/r1"), { recursive: true });
  writeFileSync(join(home, "runs/r1/state.json"), JSON.stringify({ run_id: "r1", title: "t", status: "running", edges: [], nodes: [{ id: "a", status: "running" }, { id: "b", status: "waiting" }] }));
  const flag = (n: string, on = true) => { const f = join(flags, n); if (on) writeFileSync(f, "1"); else trashSync(f); };
  const get = (pane: string, obj: object) => writeFileSync(join(gets, `${pane}.json`), JSON.stringify(obj));
  const panes = (...ids: string[]) => writeFileSync(list, JSON.stringify({ result: { panes: ids.map((p) => ({ pane_id: p, workspace_id: "ws-1", cwd: repo })) } }));
  const setCoord = (pane: string, session: string) => editJson(join(home, "runs/r1/state.json"), (s) => { s.coordinator = { pane_id: pane, socket_path: sock, workspace_id: "ws-1", session_id: session, repo, harness: "opencode", at: "t0", unreachable: null, candidates: null, backlog_pending: false }; });
  const st = () => runState(home, "r1");
  const orchMsgs = () => { const d = join(home, "runs/r1/inbox/orch"); try { return readdirSync(d).sort((x, y) => parseInt(x) - parseInt(y)).map((f) => readJson(join(d, f))); } catch { return []; } };
  const lastMsg = () => orchMsgs().at(-1);
  const drain = () => { const d = join(home, "runs/r1/inbox/orch"); try { for (const f of readdirSync(d)) { const m = readJson(join(d, f)); if (m.delivered_at == null) { m.delivered_at = "2026-01-01T00:00:00Z"; m.status = "delivered"; writeJson(join(d, f), m); } } } catch {} };
  const reset = () => { drain(); writeFileSync(log, ""); writeFileSync(text, ""); for (const f of readdirSync(flags)) trashSync(join(flags, f)); };
  return { home, o, dir, env, sock, flag, get, panes, setCoord, st, lastMsg, orchMsgs, reset, text: () => readText(text), log: () => readText(log), repo };
};

test("run set coordinator and delivery to an idle pane", () => {
  const t = setup();
  const noEnv = orch(t.home, { ...t.env, HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined });
  expect(noEnv("run", "set", "r1", "coordinator").rc).toBe(2);
  const oc = orch(t.home, { ...t.env, HERDR_PANE_ID: "p-coord", HERDR_SOCKET_PATH: t.sock, HERDR_WORKSPACE_ID: "ws-1", HERDR_ENV: "1" });
  t.get("p-coord", { agent_session: { value: "ses_abc" }, agent: "opencode" });
  expect(oc("run", "set", "r1", "coordinator").out).toMatch(/^coordinator: r1 p-coord$/m);
  const c = t.st().coordinator;
  expect([c.pane_id, c.socket_path, c.workspace_id, c.session_id]).toEqual(["p-coord", t.sock, "ws-1", "ses_abc"]);
  t.reset();
  expect(t.o("node", "ask", "r1", "a", "which db?").out).toMatch(/^m1 asked$/m);
  expect(t.lastMsg().via).toBe("herdr-coordinator");
  expect(t.text()).toBe('[orch ask #m1 from a] which db? | answer: dispatch.ts node answer r1 a m1 "<text>"\n');
  expect(t.log()).toMatch(/pane send-keys p-coord Enter/);
  expect(t.log()).toMatch(new RegExp(`^${t.sock} pane send-text`, "m"));
  t.reset(); t.o("node", "ask", "r1", "a", 'say "hi" \\ x');
  expect(t.text()).toMatch(/^\[orch ask #m2 from a\] say \\"hi\\" \\\\ x \| answer/);
  t.reset(); t.o("node", "ask", "r1", "a", "line one\nline two");
  expect(t.text().trim().split("\n").length).toBe(1);
  t.reset();
  const tell = t.o("node", "tell", "r1", "coordinator", "need a call", "--from", "a");
  expect(tell.out).toMatch(/^m\d+ coordinator delivered/m);
  expect(t.text()).toMatch(/^\[orch tell #m\d+ from a\] need a call$/m);
});
