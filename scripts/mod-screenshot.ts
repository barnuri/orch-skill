#!/usr/bin/env bun
// Captures docs/orch-graph-mod.png: the Claude Code orch-graph pane drawing a detailed mock run.
//
//   bun scripts/mod-screenshot.ts [--out FILE] [--keep]
//
// Seeds the run with `dispatch.ts demo seed --graph` in a scratch HARNESS_ORCH_HOME (trashed on
// exit) and never calls a harness. The picture is the mod's own drawGraph output, styled as a
// terminal, captured from a VISIBLE Chrome window over CDP, as demo-gif.ts does.
//
// Requires Google Chrome (or Chromium). Missing it is a SKIP, not a failure.
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { findChrome } from "./lib/chrome.ts";
import { DISPATCH, REPO_DIR, run, tmpDir, trashPath } from "./lib/util.ts";

const CAPTURE = join(REPO_DIR, "mods/orch-graph/scripts/screenshot.ts");
let outFile = join(REPO_DIR, "docs/orch-graph-mod.png");
const chromePort = 9332;
let keep = false;

const log = (m: string): void => void console.error(`mod-screenshot: ${m}`);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--out") outFile = args[++i] ?? outFile;
  else if (a === "--keep") keep = true;
  else if (a === "-h" || a === "--help") {
    console.log("mod-screenshot.ts [--out FILE] [--keep]");
    process.exit(0);
  } else {
    console.error(`mod-screenshot: unknown argument ${a}`);
    process.exit(1);
  }
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.error("SKIP: no Chrome/Chromium found");
  process.exit(0);
}
const work = mkdtempSync(join(tmpDir(), "orch-modshot-"));
const home = join(work, "home");
mkdirSync(home, { recursive: true });
const env = { HARNESS_ORCH_HOME: home };
let chrome: ReturnType<typeof Bun.spawn> | null = null;
process.on("exit", () => {
  chrome?.kill();
  if (keep) log(`scratch kept in ${work}`);
  else trashPath(work, tmpDir());
});
const die = (m: string): never => {
  console.error(`mod-screenshot: ${m}`);
  process.exit(1);
};

log("seeding the detailed graph run (no harness is called)");
if (run([process.execPath, DISPATCH, "init"], { env }).code !== 0) die("init failed");
const seed = run([process.execPath, DISPATCH, "demo", "seed", "--graph"], { env }).out;
const runId = /^demo: seeded graph run (\S+) /m.exec(seed)?.[1];
if (!runId) die("demo seed --graph failed");

log("opening Chrome (a window will appear — that is the capture)");
chrome = Bun.spawn(
  [chromeBin, `--remote-debugging-port=${chromePort}`, `--user-data-dir=${work}/chrome-profile`, "--no-first-run", "--no-default-browser-check", "--window-size=1600,900", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);
mkdirSync(dirname(outFile), { recursive: true });
const cap = run([process.execPath, CAPTURE, `--home=${home}`, `--run=${runId}`, `--port=${chromePort}`, `--out=${outFile}`]);
if (cap.code !== 0) die("capture failed");
log(`wrote ${outFile}`);
