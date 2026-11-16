import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120000);
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readJson, readText, editJson, writeJson, runState, autoCleanup } from "../helpers";
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
  const flag = (n: string, on = true) => { const f = join(flags, n); if (on) writeFileSync(f, "1"); else Bun.spawnSync(["trash", f]); };
  const get = (pane: string, obj: object) => writeFileSync(join(gets, `${pane}.json`), JSON.stringify(obj));
  const panes = (...ids: string[]) => writeFileSync(list, JSON.stringify({ result: { panes: ids.map((p) => ({ pane_id: p, workspace_id: "ws-1", cwd: repo })) } }));
  const setCoord = (pane: string, session: string) => editJson(join(home, "runs/r1/state.json"), (s) => { s.coordinator = { pane_id: pane, socket_path: sock, workspace_id: "ws-1", session_id: session, repo, harness: "opencode", at: "t0", unreachable: null, candidates: null, backlog_pending: false }; });
  const st = () => runState(home, "r1");
  const orchMsgs = () => { const d = join(home, "runs/r1/inbox/orch"); try { return readdirSync(d).sort((x, y) => parseInt(x) - parseInt(y)).map((f) => readJson(join(d, f))); } catch { return []; } };
  const lastMsg = () => orchMsgs().at(-1);
  const drain = () => { const d = join(home, "runs/r1/inbox/orch"); try { for (const f of readdirSync(d)) { const m = readJson(join(d, f)); if (m.delivered_at == null) { m.delivered_at = "2026-01-01T00:00:00Z"; m.status = "delivered"; writeJson(join(d, f), m); } } } catch {} };
  const reset = () => { drain(); writeFileSync(log, ""); writeFileSync(text, ""); for (const f of readdirSync(flags)) Bun.spawnSync(["trash", join(flags, f)]); };
  return { home, o, dir, env, sock, flag, get, panes, setCoord, st, lastMsg, orchMsgs, reset, text: () => readText(text), log: () => readText(log), repo };
};

test("gone pane: unreachable, repoint by session, candidates, ordered backlog, late answers", () => {
  const t = setup();
  t.get("p-old", { agent_status: "idle", agent_session: { value: "ses_A" } });
  t.get("p-new", { agent_status: "idle", agent_session: { value: "ses_A" } });
  t.panes("p-new"); t.setCoord("p-old", "ses_A");
  writeFileSync(join(t.dir, "flags/gone_pane"), "p-old");
  expect(t.o("node", "ask", "r1", "a", "failover q1").out).toMatch(/^m\d+ asked$/m);
  expect([t.st().coordinator.pane_id, t.st().coordinator.last_repoint.reason, t.lastMsg().via]).toEqual(["p-new", "same session", "herdr-coordinator"]);
  t.reset();
  t.get("p-x", { agent: "opencode", agent_status: "idle" }); t.get("p-y", { agent: "opencode", agent_status: "idle" });
  t.panes("p-x", "p-y"); t.setCoord("p-new", "ses_A");
  writeFileSync(join(t.dir, "flags/gone_pane"), "p-new");
  t.o("node", "ask", "r1", "a", "failover q2");
  expect([t.st().coordinator.unreachable.reason, t.st().coordinator.candidates.length, t.st().coordinator.pane_id]).toEqual(["pane or socket gone", 2, "p-new"]);
  expect([t.lastMsg().status, t.lastMsg().delivered_at ?? null]).toEqual(["pending", null]);
  expect(t.o("run", "repoint", "r1", t.sock, "p-x").out).toMatch(/^repointed: r1 p-x$/m);
  expect(t.st().coordinator.last_repoint.reason).toBe("chosen by user");
  expect(t.o("run", "repoint", "r1", t.sock, "p-zz").all).toMatch(/run repoint: p-zz in/);

  // ordered backlog after the pane returns
  t.reset(); t.panes(); t.setCoord("p-keep", "ses_A");
  writeFileSync(join(t.dir, "flags/gone_pane"), "p-keep");
  t.o("node", "ask", "r1", "a", "first in order"); t.o("node", "ask", "r1", "a", "second in order");
  t.get("p-back", { agent_status: "idle", agent_session: { value: "ses_A" } }); t.panes("p-back");
  Bun.spawnSync(["trash", join(t.dir, "flags/gone_pane")]);
  expect(t.o("run-util", "sweep", "r1").out).toMatch(/swept 2/);
  const lines = t.text().trim().split("\n");
  expect(lines[0]).toBe("2 pending node questions");
  expect(lines[1]).toMatch(/^\[orch ask #m\d+ from a\] first in order/);
  expect(lines[2]).toMatch(/^\[orch ask #m\d+ from a\] second in order/);
  expect(t.st().coordinator.backlog_pending).toBe(false);
  // late answer
  t.reset(); t.get("p-back", { agent_status: "idle", agent_session: { value: "ses_A" } }); t.setCoord("p-back", "ses_A");
  const late = t.o("node", "ask", "r1", "a", "late q", "--wait", "--timeout", "0");
  expect(late.rc).toBe(4);
  expect(t.lastMsg().answered_late_expected).toBe(true);
  t.o("node", "answer", "--ask", t.lastMsg().id, "r1", "a", "use postgres");
  expect(t.o("node", "inbox", "r1", "a").all).toMatch(/late, your ask had timed out/);
}, 120000);
