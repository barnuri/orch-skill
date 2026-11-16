#!/usr/bin/env bun
// Fast gate before a node reports done or a commit: the CLI loading on a temp home, and the
// TypeScript typecheck. Target: under 20 s.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, REPO_DIR, run, tmpDir, trashPath } from "./lib/util.ts";

let fail = false;
const home = mkdtempSync(join(tmpDir(), "orch-precommit-"));
const r = run([process.execPath, DISPATCH, "run", "status", "precommit-smoke-none"], { env: { HARNESS_ORCH_HOME: home } });
if (r.code === 0) console.log("dispatch run status: ok");
else if (r.code === 2 && (r.out + r.err).includes("unknown run")) {
  // The CLI loaded and refused the unknown run cleanly (exit 2). Any other failure is a broken load.
  console.log("dispatch run status: ok (libs load, unknown run refused)");
} else {
  console.error(`precommit-smoke: dispatch run status failed:\n${(r.out + r.err).replace(/^/gm, "  ")}`);
  fail = true;
}
trashPath(home, tmpDir());

const t = run([process.execPath, join(REPO_DIR, "scripts/typecheck.ts")]);
process.stdout.write(t.out);
process.stderr.write(t.err);
if (t.code !== 0) fail = true;

if (fail) console.error("precommit-smoke: FAILED");
else console.log("precommit-smoke: ok");
process.exit(fail ? 1 : 0);
