import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readJson, readText, editJson, runState, autoCleanup } from "../helpers";
autoCleanup();

// Fake herdr (TypeScript, run by bun): logs calls, answers pane get/list/read, records send-text.
const FAKE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const a = process.argv.slice(2), e = process.env;
appendFileSync(e.FAKE_LOG!, (e.HERDR_SOCKET_PATH ?? "") + " " + a.join(" ") + "\\n");
const flag = (n: string) => !!e[n] && existsSync(e[n]!.startsWith("/") ? e[n]! : "/nonexistent");
const cmd = a.slice(0, 2).join(" ");
const mode = (n: string) => existsSync(e.FAKE_FLAGS + "/" + n);
if (cmd === "pane get") {
  if (mode("gone") || (existsSync(e.FAKE_FLAGS + "/gone_pane") && readFileSync(e.FAKE_FLAGS + "/gone_pane", "utf8").trim() === a[2])) process.exit(1);
  const f = e.FAKE_GETS + "/" + a[2] + ".json";
  if (existsSync(f)) process.stdout.write(readFileSync(f, "utf8"));
  else console.log(JSON.stringify({ agent_status: mode("working") ? "working" : "idle" }));
} else if (cmd === "pane list") { if (existsSync(e.FAKE_LIST!)) process.stdout.write(readFileSync(e.FAKE_LIST!, "utf8")); }
else if (cmd === "pane read") {
  if (mode("read_fail")) process.exit(1);
  if (mode("changing")) console.log(String(process.hrtime.bigint()));
  console.log("output"); console.log(mode("typing") ? "❯ half a draft" : "❯");
} else if (cmd === "pane send-text") { if (mode("send_fail")) process.exit(1); appendFileSync(e.FAKE_TEXT!, a[3] + "\\n"); }
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
  const reset = () => { writeFileSync(log, ""); writeFileSync(text, ""); for (const f of readdirSync(flags)) Bun.spawnSync(["trash", join(flags, f)]); };
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
  expect(t.text()).toBe('[orch ask #m1 from a] which db? | answer: dispatch.sh node answer r1 a m1 "<text>"\n');
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
  for (let i = 0; i < 9; i++) t.o("run", "sweep-coordinator", "r1");
  expect(t.lastMsg().tries).toBeGreaterThanOrEqual(10);
  t.reset(); t.flag("working"); t.o("node", "ask", "r1", "a", "later"); t.flag("working", false);
  t.o("run", "sweep-coordinator", "r1");
  expect(t.lastMsg().via).toBe("herdr-coordinator");
  t.reset(); t.flag("send_fail");
  expect(t.o("node", "ask", "r1", "a", "send fails").out).toMatch(/^m\d+ asked$/m);
  expect([t.lastMsg().status, t.lastMsg().delivered_at ?? null]).toEqual(["pending", null]);
  expect(t.st().coordinator.unreachable.reason).toMatch(/^send failed/);
  t.flag("send_fail", false); t.o("run", "sweep-coordinator", "r1");
  expect(t.lastMsg().via).toBe("herdr-coordinator");
  expect(t.st().coordinator.unreachable ?? null).toBeNull();
});

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
  expect(t.o("run", "sweep-coordinator", "r1").out).toMatch(/swept 2/);
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
