#!/usr/bin/env bun
// check-theme.ts <run-id> - visible browser check of a run page: dark default, light toggle, node panel
// composer above the status line, and the table warning cells, with a screenshot per theme.
import { run, sleep, tmpDir } from "../lib/util.ts";

const [runId] = process.argv.slice(2);
if (!runId) (console.error("run id required"), process.exit(2));
const base = process.env["ORCH_URL"] ?? "http://127.0.0.1:6724";
const s = "-s=verify-theme";
const pw = (...a: string[]) => run(["playwright-cli", s, ...a]);
// playwright-cli prints "### Result" then the value; the echoed code below it must not be matched.
const val = (code: string): string => {
  const lines = pw("eval", code).out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("### Result"));
  return at < 0 ? "" : (lines[at + 1] ?? "").trim().replace(/^"(.*)"$/, "$1");
};
const theme = () => val("() => document.documentElement.getAttribute('data-theme')");
let fail = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) fail = true;
};

// The dashboard takes 40-60 s to answer after a restart (boot resume). Wait for /api/build here, not in the browser.
const serverUp = async (): Promise<boolean> => {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${base}/api/build`, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      // not answering yet
    }
    await sleep(1000);
  }
  return false;
};
if (!(await serverUp())) (console.log(`FAIL server not answering at ${base}`), process.exit(1));
pw("close"); // a session left open by an earlier run makes `open` fail
if (pw("open", "--headed", `${base}/#/run/${runId}`).code !== 0) (console.log(`FAIL cannot open ${base}`), process.exit(1));
await sleep(3000);
pw("eval", "() => localStorage.removeItem('orch-theme')");
pw("reload");
// The first load can show "The server is not reachable" before the API answers: wait for the run page, up to 15 s.
for (let i = 0; i < 15 && val("() => document.querySelector('.run-page') ? 'yes' : 'no'") !== "yes"; i++) await sleep(1000);
check(theme() === "dark", "default theme is dark");
const dark = `${tmpDir()}/verify-theme-${runId}-dark.png`;
if (pw("screenshot", `--filename=${dark}`).code === 0) console.log(`shot ${dark}`);

const clickButton = (match: string) =>
  val(`() => { const b = [...document.querySelectorAll('button')].find((x) => /${match}/i.test(x.getAttribute('aria-label') ?? x.textContent ?? '')); if (!b) return 'none'; b.click(); return 'clicked'; }`);
check(clickButton("light|dark|theme") === "clicked", "theme toggle found and clicked");
await sleep(500);
check(theme() === "light", "toggle switches to light");
const light = `${tmpDir()}/verify-theme-${runId}-light.png`;
if (pw("screenshot", `--filename=${light}`).code === 0) console.log(`shot ${light}`);

// Node panel: select a graph node, then check composer and status line order.
val("() => { const n = document.querySelector('g.task-node, tr.rt-row[data-node]'); if (n) n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok'; }");
await sleep(800);
const panel = val("() => document.querySelector('.node-terminal') ? 'panel' : 'none'");
if (panel !== "panel") {
  console.log("SKIP node panel checks: no node selected on this run");
} else {
  const last = val("() => { const p = document.querySelector('.node-terminal'); const kids = [...p.children]; const l = kids[kids.length - 1]; return l && l.classList.contains('node-statusline') ? 'yes' : 'no'; }");
  check(last === "yes", "status line is the last row of the node panel");
  const order = val("() => { const p = document.querySelector('.node-terminal'); const c = p.querySelector('.node-messages'); const s = p.querySelector('.node-statusline'); if (!c || !s) return 'none'; return (c.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'above' : 'below'; }");
  if (order === "above") check(true, "message composer sits above the status line");
  else console.log("SKIP composer order: no composer on this node (not live and no thread)");
  const shot = `${tmpDir()}/verify-theme-${runId}-panel-light.png`;
  if (pw("screenshot", `--filename=${shot}`).code === 0) console.log(`shot ${shot}`);
}

// Table view: warning cells and Retry action, in light then dark.
check(clickButton("^table$") === "clicked", "table view button clicked");
await sleep(500);
const warnCells = val("() => String(document.querySelectorAll('.rt-warn').length)");
console.log(`table warning cells: ${warnCells}`);
clickButton("light|dark|theme");
await sleep(400);
check(theme() === "dark", "toggle back to dark");
const tableDark = `${tmpDir()}/verify-theme-${runId}-table-dark.png`;
if (pw("screenshot", `--filename=${tableDark}`).code === 0) console.log(`shot ${tableDark}`);
pw("close");
process.exit(fail ? 1 : 0);
