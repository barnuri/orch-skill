#!/usr/bin/env bun
// Records docs/demo.gif: seeds mock runs, serves the dashboard against them, drives a real
// Chrome window through a storyboard, and assembles the frames with ffmpeg.
//
//   bun scripts/demo-gif.ts [--out FILE] [--port P] [--keep-frames]
//
// Re-runnable and self-contained. It never touches your real state dir: everything is seeded
// into a scratch HARNESS_ORCH_HOME that is trashed on exit, and it never calls a harness.
//
// Chrome runs with a VISIBLE window on purpose: `chrome --screenshot` implies headless, and the
// frames are captured over the DevTools protocol instead (see scripts/lib/cdp-session.ts).
//
// Requires ffmpeg and Google Chrome. Missing either is a SKIP, not a failure.
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { findChrome } from "./lib/chrome.ts";
import { DISPATCH, REPO_DIR, run, sleep, tmpDir, trashPath, which } from "./lib/util.ts";

const RECORDER = join(REPO_DIR, "scripts/lib/demo-record.ts");
let outFile = join(REPO_DIR, "docs/demo.gif");
let servePort = 6931;
const chromePort = 9331;
let keepFrames = false;
const GIF_FPS = 8;
const GIF_WIDTH = 1280;

const log = (m: string): void => void console.error(`demo-gif: ${m}`);
const skip = (m: string): never => {
  console.error(`SKIP: ${m}`);
  process.exit(0);
};

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--out") outFile = args[++i] ?? outFile;
  else if (a === "--port") servePort = Number(args[++i] ?? servePort);
  else if (a === "--keep-frames") keepFrames = true;
  else if (a === "-h" || a === "--help") {
    console.log(`demo-gif.ts [--out FILE] [--port P] [--keep-frames]`);
    process.exit(0);
  } else {
    console.error(`demo-gif: unknown argument ${a}`);
    process.exit(1);
  }
}

if (!which("ffmpeg")) skip("ffmpeg not found — install it to record the GIF");
const chromeBin = findChrome() ?? skip("no Chrome/Chromium found — install one to record the GIF");

const work = mkdtempSync(join(tmpDir(), "orch-demo-"));
const home = join(work, "home");
const frames = join(work, "frames");
mkdirSync(home, { recursive: true });
mkdirSync(frames, { recursive: true });
const env = { HARNESS_ORCH_HOME: home };
let chrome: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;

function cleanup(): void {
  chrome?.kill();
  run([process.execPath, DISPATCH, "serve", "--stop"], { env });
  server?.kill();
  trashPath(home, tmpDir());
  if (keepFrames) log(`frames kept in ${work}`);
  else trashPath(work, tmpDir());
}
process.on("exit", cleanup);
const die = (m: string): never => {
  console.error(`demo-gif: ${m}`);
  process.exit(1);
};

log("seeding mock runs (no harness is called)");
if (run([process.execPath, DISPATCH, "init"], { env }).code !== 0) die("init failed");
if (run([process.execPath, DISPATCH, "demo", "seed"], { env }).code !== 0) die("demo seed failed");
const list = run([process.execPath, DISPATCH, "run", "list"], { env }).out;
const runId = list.split("\n").map((l) => l.split("\t")).find((c) => c[1] === "running")?.[0];
if (!runId) die("no running demo run to record");

log(`serving the dashboard on 127.0.0.1:${servePort}`);
server = Bun.spawn([process.execPath, DISPATCH, "serve", "--host", "127.0.0.1", "--port", String(servePort)], {
  env: { ...process.env, ...env } as Record<string, string>,
  stdout: Bun.file(join(work, "serve.log")),
  stderr: Bun.file(join(work, "serve.log")),
});
const url = `http://127.0.0.1:${servePort}/`;
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  up = await fetch(url).then((r) => r.ok, () => false);
  if (!up) await sleep(250);
}
if (!up) die(`dashboard did not come up — see ${work}/serve.log`);

log("opening Chrome (a window will appear — that is the recording)");
chrome = Bun.spawn(
  [chromeBin, `--remote-debugging-port=${chromePort}`, `--user-data-dir=${work}/chrome-profile`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

log("recording the storyboard");
const rec = run([process.execPath, RECORDER, `--port=${chromePort}`, `--base-url=${url.replace(/\/$/, "")}`, `--run=${runId}`, `--out=${frames}`, `--dispatch=${DISPATCH}`, `--home=${home}`]);
if (rec.code !== 0) die("recording failed");
const count = Number(rec.out.trim().split("\n").pop()) || 0;
if (count <= 0) die("no frames captured");
log(`captured ${count} frames`);

mkdirSync(dirname(outFile), { recursive: true });
// Two passes: a palette built from the whole clip, then applied; one pass would dither each frame
// against its own palette and the UI's flat surfaces would visibly crawl.
log(`encoding ${outFile}`);
const pass1 = run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(GIF_FPS), "-i", `${frames}/frame-%04d.png`, "-vf", `scale=${GIF_WIDTH}:-1:flags=lanczos,palettegen=stats_mode=diff`, `${work}/palette.png`]);
if (pass1.code !== 0) die("palettegen failed");
const pass2 = run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(GIF_FPS), "-i", `${frames}/frame-%04d.png`, "-i", `${work}/palette.png`, "-lavfi", `scale=${GIF_WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, "-loop", "0", outFile]);
if (pass2.code !== 0) die("gif encode failed");
log(`wrote ${outFile} (${existsSync(outFile) ? Math.round(statSync(outFile).size / 1024) : 0}K)`);
