#!/usr/bin/env bun
// Fast gate before a node reports done or a commit: the CLI loading on a temp home, and the
// cached typecheck and a syntax check (bun build) of changed .ts/.tsx files only. Target: under 10 s.
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, REPO_DIR, run, tmpDir, trashPath } from "./lib/util.ts";

const changed = run(["git", "status", "--porcelain", "-uall"], { cwd: REPO_DIR })
  .out.split("\n")
  .map((l) => l.slice(3).replace(/^.* -> /, ""))
  .filter((f) => /\.tsx?$/.test(f) && existsSync(join(REPO_DIR, f)));

async function sh(cmd: string[], env?: Record<string, string>): Promise<{ code: number; text: string }> {
  const p = Bun.spawn(cmd, { cwd: REPO_DIR, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...env } as Record<string, string> });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, text: o + e };
}

let fail = false;
const home = mkdtempSync(join(tmpDir(), "orch-precommit-"));
const out = mkdtempSync(join(tmpDir(), "orch-precommit-build-"));
const [r, t, syn] = await Promise.all([
  sh([process.execPath, DISPATCH, "run", "status", "precommit-smoke-none"], { HARNESS_ORCH_HOME: home }),
  sh([process.execPath, join(REPO_DIR, "scripts/typecheck.ts")]),
  Promise.all(changed.map(async (f) => ({ f, ...(await sh([process.execPath, "build", f, "--no-bundle", "--outdir", out])) }))),
]);
if (r.code === 0) console.log("dispatch run status: ok");
else if (r.code === 2 && r.text.includes("unknown run")) {
  // The CLI loaded and refused the unknown run cleanly (exit 2). Any other failure is a broken load.
  console.log("dispatch run status: ok (libs load, unknown run refused)");
} else {
  console.error(`precommit-smoke: dispatch run status failed:\n${r.text.replace(/^/gm, "  ")}`);
  fail = true;
}
for (const b of syn) {
  if (b.code !== 0) {
    console.error(`precommit-smoke: syntax error in ${b.f}:\n${b.text}`);
    fail = true;
  }
}
console.log(`syntax: ${changed.length} changed file(s) checked`);
trashPath(home, tmpDir());
trashPath(out, tmpDir());
process.stdout.write(t.text);
if (t.code !== 0) fail = true;

if (fail) console.error("precommit-smoke: FAILED");
else console.log("precommit-smoke: ok");
process.exit(fail ? 1 : 0);
