#!/usr/bin/env bun
// check-run-page.ts <run-id> [text ...] - open the run page headless, require every text, save a screenshot.
import { run, sleep, tmpDir } from "../lib/util.ts";

const [runId, ...texts] = process.argv.slice(2);
if (!runId) (console.error("run id required"), process.exit(2));
const base = process.env["ORCH_URL"] ?? "http://127.0.0.1:6724";
const s = "-s=verify";
const shot = `${tmpDir()}/verify-run-${runId}.png`;
const pw = (...a: string[]) => run(["playwright-cli", s, ...a]);
let fail = false;
if (pw("open", `${base}/#/run/${runId}`).code !== 0) (console.log(`FAIL cannot open ${base}`), process.exit(1));
await sleep(4000);
const text = pw("eval", "() => document.body.innerText").out;
if (text) console.log(`PASS page rendered (${text.length} chars)`);
else (console.log("FAIL empty page"), (fail = true));
for (const t of texts) {
  if (text.includes(t)) console.log(`PASS text: ${t}`);
  else (console.log(`FAIL missing text: ${t}`), (fail = true));
}
if (pw("screenshot", `--filename=${shot}`).code === 0) console.log(`shot ${shot}`);
pw("close");
process.exit(fail ? 1 : 0);
