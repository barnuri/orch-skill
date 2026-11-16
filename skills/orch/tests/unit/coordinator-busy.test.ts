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

test("busy, typing, changing, unreadable, send failure, retries", () => {
  const t = setup();
  t.get("p-coord", { agent_session: { value: "ses_abc" }, agent: "opencode" });
  t.setCoord("p-coord", "ses_abc");
  const defers = (flag: string, q: string) => {
    t.reset(); t.flag(flag);
    t.o("node", "ask", "r1", "a", q);
    t.flag(flag, false);
    return [t.lastMsg().status, t.lastMsg().tries, t.text()];
  };
  expect(defers("working", "busy?")).toEqual(["pending", 1, ""]);
  expect(defers("typing", "typed over?")).toEqual(["pending", 1, ""]);
  expect(defers("changing", "moving screen?")).toEqual(["pending", 1, ""]);
  expect(defers("read_fail", "unreadable?")).toEqual(["pending", 1, ""]);
  t.reset(); t.o("node", "ask", "r1", "a", "quiet");
  expect(t.lastMsg().via).toBe("herdr-coordinator");
  // 10 tries to a working pane: the ask fails after 10, then a sweep delivers a later one once idle
  t.reset(); t.flag("working"); t.o("node", "ask", "r1", "a", "never ends");
  for (let i = 0; i < 9; i++) t.o("run-util", "sweep", "r1");
  expect(t.lastMsg().tries).toBeGreaterThanOrEqual(10);
  t.reset(); t.flag("working"); t.o("node", "ask", "r1", "a", "later"); t.flag("working", false);
  t.o("run-util", "sweep", "r1");
  expect(t.lastMsg().via).toBe("herdr-coordinator");
  t.reset(); t.flag("send_fail");
  expect(t.o("node", "ask", "r1", "a", "send fails").out).toMatch(/^m\d+ asked$/m);
  expect([t.lastMsg().status, t.lastMsg().delivered_at ?? null]).toEqual(["pending", null]);
  expect(t.st().coordinator.unreachable.reason).toMatch(/^send failed/);
  t.flag("send_fail", false); t.o("run-util", "sweep", "r1");
  expect(t.lastMsg().via).toBe("herdr-coordinator");
  expect(t.st().coordinator.unreachable ?? null).toBeNull();
});
