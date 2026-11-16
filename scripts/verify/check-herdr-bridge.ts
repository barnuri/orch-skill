#!/usr/bin/env bun
// check-herdr-bridge.ts - throwaway run in a temp orch home; its coordinator is a harmless fake-agent pane in that
// home's own orch herdr instance (never the user's herdr). Checks delivery, the one-line format, the busy and
// typing deferrals and the repoint after the pane is replaced. Prints PASS or FAIL per check; exit 1 on any FAIL.
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
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
if (c.last_repoint?.reason !== "same session") console.log("NOTE herdr 0.9.5 does not expose agent_session on a synthetic pane: the same-session path is covered by unit tests, this run used the harness+repo match");
d(["herdr", "stop"]);
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);
