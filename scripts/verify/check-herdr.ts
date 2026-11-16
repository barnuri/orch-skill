#!/usr/bin/env bun
// check-herdr.ts [--lifecycle [--no-orphan]] - PASS or FAIL per check; exit 1 on any FAIL.
// Default (read only): the real orch herdr instance answers, every node tab has one pane. Never touches the user's herdr.
// --lifecycle: a throwaway run in a temp home with a fake claude: one workspace, one tab titled <node>, one pane,
// ANSI in the pane and in `log` but not in `log.plain`, the tab closes after the linger (5 s), an orphan pane after 60 s.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, HOME, run, sleep, tmpDir, trashPath } from "../lib/util.ts";
import { instHome } from "../../skills/orch/core/adapters/herdr.ts";

for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete process.env[k];
const lifecycle = process.argv.includes("--lifecycle");
let fail = false;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || (fail = true));
const json = (t: string): any => { try { return JSON.parse(t); } catch { return null; } };
const herdr = (H: string, ...a: string[]) => json(run(["herdr", ...a], { env: { HOME: H } }).out);

if (!lifecycle) {
  const H = process.env["ORCH_HERDR_HOME"] ?? join(HOME, ".harness-orch/herdr/home");
  const panes: any[] | undefined = herdr(H, "pane", "list")?.result?.panes;
  if (!panes) (console.log(`FAIL orch herdr instance not answering (${H})`), process.exit(1));
  check(true, `orch herdr answers, ${panes.length} panes`);
  for (const w of herdr(H, "workspace", "list")?.result?.workspaces ?? []) {
    const tabs: any[] = herdr(H, "tab", "list", "--workspace", w.workspace_id)?.result?.tabs ?? [];
    for (const t of tabs) check(panes.filter((p) => p.tab_id === t.tab_id).length === 1, `workspace ${w.label} tab ${t.label} has one pane`);
  }
  process.exit(fail ? 1 : 0);
}

const root = realpathSync(mkdtempSync(join(tmpDir(), "herdr-life-")));
const home = join(root, "h");
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "claude"), '#!/bin/sh\nprintf "\\033[31mred\\033[0m \\033[1;32mgreen\\033[0m\\n"\nsleep 10\n');
chmodSync(join(bin, "claude"), 0o755);
const env = { HARNESS_ORCH_HOME: home, ORCH_HERDR: "1", PATH: `${bin}:${process.env["PATH"]}` };
const d = (a: string[]) => run([process.execPath, DISPATCH, ...a], { env });
d(["init"]);
const prof = join(home, "profiles.json");
const doc = json(readFileSync(prof, "utf8"));
doc.settings.herdr_linger_sec = 5;
writeFileSync(prof, JSON.stringify(doc));
d(["run", "start", "life", "--id", "lf1"]);
d(["node", "add", "lf1", "n1", "tiny"]);
check(d(["node", "dispatch", "lf1", "n1", "claude", "hi"]).code === 0, "node dispatched through herdr");
const H = instHome(home)!;
const wss: any[] = herdr(H, "workspace", "list")?.result?.workspaces ?? [];
const tabs: any[] = herdr(H, "tab", "list")?.result?.tabs ?? [];
const panes: any[] = herdr(H, "pane", "list")?.result?.panes ?? [];
check(wss.length === 1 && wss[0].label === "lf1", `one workspace for the run (${wss.map((w) => w.label)})`);
check(tabs.length === 1 && tabs[0].label === "n1", `one tab titled n1 (${tabs.map((t) => t.label)})`);
check(panes.length === 1, `one pane (${panes.length})`);
await sleep(13000);
const esc = String.fromCharCode(27);
const ansi = run(["herdr", "pane", "read", panes[0].pane_id, "--format", "ansi", "--lines", "10"], { env: { HOME: H } }).out;
check(ansi.includes(`${esc}[`), "pane output has ANSI colour codes");
const jobDir = join(home, "jobs", readdirSync(join(home, "jobs"))[0]!);
await sleep(5000);
check(readFileSync(join(jobDir, "log"), "utf8").includes(`${esc}[31m`), "log keeps ANSI");
check(!readFileSync(join(jobDir, "log.plain"), "utf8").includes(esc), "log.plain has no ANSI");
await sleep(6000);
check((herdr(H, "tab", "list")?.result?.tabs ?? []).length === 0, "tab closed after the 5 s linger");
if (!process.argv.includes("--no-orphan")) {
  run(["herdr", "workspace", "create", "--label", "orphan", "--cwd", root], { env: { HOME: H } });
  d(["herdr", "sweep"]);
  await sleep(62000);
  d(["herdr", "sweep"]);
  check((herdr(H, "pane", "list")?.result?.panes ?? []).length === 0, "orphan pane swept after 60 s");
}
d(["herdr", "stop"]);
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);
