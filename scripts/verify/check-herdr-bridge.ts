#!/usr/bin/env bun
// check-herdr-bridge.ts - throwaway run in a temp orch home; its coordinator is a harmless fake-agent pane in that
// home's own orch herdr instance (never the user's herdr). Checks delivery, the one-line format, the busy and
// typing deferrals and the repoint after the pane is replaced. Prints PASS or FAIL per check; exit 1 on any FAIL.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, run, sleep, tmpDir, trashPath } from "../lib/util.ts";
import { instHome } from "../../skills/orch/core/adapters/herdr.ts";

for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpDir(), "bridge-")));
const home = join(root, "h");
const cwd = realpathSync(root);
const base = { HARNESS_ORCH_HOME: home, ORCH_HERDR: "1", HOME: root, ORCH_COORD_SETTLE_SECS: "0.5", OPENCODE: "1" };
const d = (a: string[], env: Record<string, string> = {}) => run([process.execPath, DISPATCH, ...a], { cwd, env: { ...base, ...env } });
const inst = () => instHome(home)!;
const h = (...a: string[]) => run(["herdr", ...a], { env: { ...base, HOME: inst() } });
const json = (t: string) => { try { return JSON.parse(t); } catch { return {}; } };
let fail = false;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || (fail = true));
const msgs = () => json(d(["run", "messages", "br1", "--json"]).out || "[]") as any[];
const msg = (id: string) => msgs().find((m) => m.id === id);
const askId = (q: string) => d(["node", "ask", "br1", "n1", q]).out.trim().split(/\s+/)[0]!;
const screen = (p: string) => h("pane", "read", p, "--source", "recent-unwrapped", "--lines", "30").out;
const agentPane = async (ws: string, state: string) => {
  const p = json(h("pane", "list", "--workspace", ws).out).result.panes[0].pane_id as string;
  h("pane", "run", p, `sh -c 'while printf "> "; IFS= read -r l; do echo "got: $l"; done'`);
  await sleep(1500);
  h("pane", "report-agent", p, "--source", "verify", "--agent", "opencode", "--state", state);
  return p;
};
const ws = (label: string) => json(h("workspace", "create", "--label", label, "--cwd", cwd).out).result.workspace.workspace_id as string;
const coordinator = (p: string) => d(["run", "set", "br1", "coordinator"], { HERDR_PANE_ID: p, HERDR_SOCKET_PATH: join(inst(), ".config/herdr/herdr.sock") });

d(["init"]); d(["run", "start", "bridge check", "--id", "br1"]); d(["node", "add", "br1", "n1", "fake"]);
check(d(["herdr", "ensure"]).code === 0, "orch herdr instance started (temp home)");
let pane = await agentPane(ws("coord"), "idle");
check(coordinator(pane).code === 0, `coordinator recorded: pane ${pane}`);
const a = askId("is the bridge alive?");
await sleep(500);
check(!!msg(a)?.delivered_at, `ask ${a} delivered_at ${msg(a)?.delivered_at ?? "unset"}`);
const line = screen(pane).split("\n").find((l) => l.includes(`#${a} `)) ?? "";
check(/\[orch ask #m\d+ from n1\] is the bridge alive\? \| answer: dispatch\.ts node answer br1 n1 m\d+ "<text>"/.test(line), `one-line format: ${line.trim().slice(0, 90)}`);
h("pane", "report-agent", pane, "--source", "verify", "--agent", "opencode", "--state", "working");
const b = askId("busy question");
check(!msg(b)?.delivered_at && /working/.test(msg(b)?.last_error ?? ""), `busy: ${b} deferred (${msg(b)?.last_error})`);
h("pane", "report-agent", pane, "--source", "verify", "--agent", "opencode", "--state", "idle");
d(["run", "messages", "br1", "retry"]);
check(!!msg(b)?.delivered_at, `busy: ${b} delivered after idle`);
h("pane", "send-text", pane, "half typed");
const t = askId("typing question");
check(!msg(t)?.delivered_at && /typing/.test(msg(t)?.last_error ?? ""), `typing: ${t} deferred (${msg(t)?.last_error})`);
h("pane", "send-keys", pane, "Enter");
d(["run", "messages", "br1", "retry"]);
check(!!msg(t)?.delivered_at, `typing: ${t} delivered after the input cleared`);
const second = ws("coord2");
h("pane", "close", pane);
pane = await agentPane(second, "idle");
const r = askId("after replace");
const c = json(readFileSync(join(home, "runs/br1/state.json"), "utf8")).coordinator;
check(c.pane_id === pane && !!msg(r)?.delivered_at, `repoint: coordinator now ${c.pane_id} (${c.last_repoint?.reason}), ${r} delivered`);
// Repoint by session id. herdr 0.9.5 fills agent_session only when the pane runs a process named like the agent
// (a fake `opencode` binary here) and the report comes from the source "herdr:opencode"; other sources are ignored. A decoy pane has the same harness, repo and cwd but another session,
// so the harness+repo match would find two candidates and guess nothing: only the session id can pick the right one.
let seq = 0;
const sessionState = (p: string, state: string, sid: string) => {
  h("pane", "report-agent", p, "--source", "herdr:opencode", "--agent", "opencode", "--state", state, "--seq", String(++seq));
  h("pane", "report-agent-session", p, "--source", "herdr:opencode", "--agent", "opencode", "--agent-session-id", sid, "--session-start-source", "startup", "--seq", String(++seq));
};
const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "opencode"), '#!/bin/sh\nwhile printf "> "; IFS= read -r l; do echo "got: $l"; done\n', { mode: 0o755 });
const sessionPane = async (w: string, sid: string) => {
  const p = json(h("pane", "list", "--workspace", w).out).result.panes[0].pane_id as string;
  h("pane", "run", p, `PATH=${fakeBin}:$PATH opencode --session ${sid}`);
  await sleep(2500);
  sessionState(p, "idle", sid);
  return p;
};
const sidOf = (p: string) => json(h("pane", "get", p).out).result?.pane?.agent_session?.value ?? "";
const coordState = () => json(readFileSync(join(home, "runs/br1/state.json"), "utf8")).coordinator;
h("pane", "close", pane);
const sessA = await sessionPane(ws("sessA"), "ses_A");
check(sidOf(sessA) === "ses_A", `herdr reports agent_session ses_A on ${sessA}`);
check(coordinator(sessA).code === 0 && coordState().session_id === "ses_A", `coordinator recorded with session_id ${coordState().session_id}`);
h("pane", "close", sessA);
const q = [askId("first pending"), askId("second pending"), askId("third pending")];
check(q.every((i) => !msg(i)?.delivered_at) && coordState().unreachable != null, `coordinator gone: ${q.join(",")} stay pending, unreachable set`);
const decoy = await sessionPane(ws("decoy"), "ses_B");
const back = await sessionPane(ws("back"), "ses_A");
const cands = [decoy, back].map((p) => `${p}=${sidOf(p)}`).join(" ");
d(["run", "messages", "br1", "retry"]);
const c2 = coordState();
check(c2.pane_id === back && c2.last_repoint?.reason === "same session", `repoint by session id: ${c2.pane_id} (${c2.last_repoint?.reason}) over decoy ${decoy}; panes ${cands}`);
const lines = screen(back).split("\n");
const at = (s: string) => lines.findIndex((l) => l.includes(s));
const notice = at("3 pending node questions");
check(notice >= 0, `one-line backlog notice typed on ${back}: ${(lines[notice] ?? "").trim()}`);
const idx = q.map((i) => at(`#${i} `));
check(idx.every((n) => n > notice) && idx[0]! < idx[1]! && idx[1]! < idx[2]!, `pending asks redelivered in order after the notice: ${q.join(" < ")} (lines ${idx.join(",")}, notice ${notice})`);
check(q.every((i) => !!msg(i)?.delivered_at), "all three delivered_at set");
check(!screen(decoy).includes("[orch ask"), `decoy pane ${decoy} (ses_B) received nothing`);
sessionState(back, "working", "ses_A");
const w2 = askId("busy after session repoint");
check(!msg(w2)?.delivered_at && /working/.test(msg(w2)?.last_error ?? ""), `busy after repoint: ${w2} deferred`);
sessionState(back, "idle", "ses_A");
h("pane", "send-text", back, "half typed");
const w3 = askId("typing after session repoint");
check(!msg(w3)?.delivered_at && /typing/.test(msg(w3)?.last_error ?? ""), `typing after repoint: ${w3} deferred`);
h("pane", "send-keys", back, "Enter");
d(["run", "messages", "br1", "retry"]);
check(!!msg(w2)?.delivered_at && !!msg(w3)?.delivered_at, `both deferred asks delivered once quiet (${w2}, ${w3})`);
d(["herdr", "stop"]);
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);
