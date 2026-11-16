#!/usr/bin/env bun
// check-herdr-tabs.ts [--linger] - throwaway run in a temp home, own orch herdr instance (never the user's herdr).
// Default: a retry reuses the node's tab (same tab id, renamed "<node> #2", one tab, one pane).
// --linger: also waits for the REAL default linger (herdr_linger_sec and ORCH_HERDR_CLOSE_AFTER unset = 300 s): the
// tab must still be open 270 s after the job ended and gone by 335 s (about 6 minutes; run it in the background).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, run, sleep, tmpDir, trashPath } from "../lib/util.ts";
import { instHome } from "../../skills/orch/core/adapters/herdr.ts";

for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "ORCH_HERDR_CLOSE_AFTER"]) delete process.env[k];
const long = process.argv.includes("--linger");
let fail = false;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || (fail = true));
const json = (t: string): any => { try { return JSON.parse(t); } catch { return null; } };
const root = realpathSync(mkdtempSync(join(tmpDir(), "herdr-tabs-")));
const home = join(root, "h");
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "claude"), "#!/bin/sh\nsleep 4\n");
chmodSync(join(bin, "claude"), 0o755);
const env = { HARNESS_ORCH_HOME: home, ORCH_HERDR: "1", PATH: `${bin}:${process.env["PATH"]}` };
const d = (a: string[]) => run([process.execPath, DISPATCH, ...a], { env });
const H = () => instHome(home)!;
const tabs = (): any[] => json(run(["herdr", "tab", "list"], { env: { HOME: H() } }).out)?.result?.tabs ?? [];
const panes = (): any[] => json(run(["herdr", "pane", "list"], { env: { HOME: H() } }).out)?.result?.panes ?? [];
const jobs = () => readdirSync(join(home, "jobs")).sort().map((j) => join(home, "jobs", j));
const ended = (j: string) => { try { return statSync(join(j, "exit_code")).mtimeMs / 1000; } catch { return 0; } };
const waitEnd = async (j: string) => { for (let i = 0; i < 60 && !ended(j); i++) await sleep(1000); return ended(j); };

d(["init"]);
d(["run", "start", "tabs", "--id", "tb1"]);
d(["node", "add", "tb1", "n1", "tiny"]);
check(d(["node", "dispatch", "tb1", "n1", "claude", "hi"]).code === 0, "attempt 1 dispatched through herdr");
const first = tabs();
check(first.length === 1 && first[0].label === "n1", `attempt 1: one tab titled n1 (${first.map((t) => `${t.tab_id}=${t.label}`)})`);
check(!!(await waitEnd(jobs()[0]!)), "attempt 1 ended");
d(["node", "update", "tb1", "n1", "error", "--error", "fake failure"]);
const r = d(["node", "retry", "tb1", "n1"]);
check(r.code === 0, `node retry dispatched (${r.out.trim().split("\n")[0]}${r.err.trim() ? " " + r.err.trim().slice(0, 100) : ""})`);
const second = tabs();
check(second.length === 1 && second[0].tab_id === first[0]?.tab_id, `retry reuses the tab: ${first[0]?.tab_id} -> ${second.map((t) => t.tab_id)}, one tab`);
check(second[0]?.label === "n1 #2", `retry tab titled "${second[0]?.label}"`);
check(panes().length === 1, `one pane after the retry (${panes().length})`);
check(jobs().length === 2 && readFileSync(join(jobs()[1]!, "herdr_tab"), "utf8").trim() === first[0]?.tab_id, "second job dir records the same herdr_tab");
const end2 = await waitEnd(jobs()[1]!);
check(!!end2, "attempt 2 ended");
if (long && end2) {
  const age = () => Date.now() / 1000 - end2;
  while (age() < 270) await sleep(5000);
  check(tabs().length === 1, `tab still open ${age().toFixed(0)} s after the job ended (linger 300 s)`);
  let gone = -1;
  while (age() < 345) { if (tabs().length === 0) { gone = age(); break; } await sleep(2000); }
  check(gone >= 295 && gone <= 335, `tab closed ${gone.toFixed(0)} s after the job ended (default linger 300 s)`);
}
d(["herdr", "stop"]);
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);
