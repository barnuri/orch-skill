#!/usr/bin/env bun
// Test double for the dispatch.ts a loop iteration spawns: `run` prints a counted reply, everything else goes to the real one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const a = process.argv.slice(2);
if (a[0] === "run" && a[1] === "--profile") {
  const dir = process.env.FAKE_LOOP_DIR ?? ".";
  const file = `${dir}/count`;
  const n = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(n));
  if (process.env.FAKE_LOOP_FAIL === "1") {
    console.error("boom");
    process.exit(3);
  }
  process.stdout.write(`reply ${n}${n >= Number(process.env.FAKE_LOOP_DONE_AT ?? 9999) ? " DONE" : ""}\n`);
  process.exit(0);
}
const real = resolve(import.meta.dir, "../../../../skills/orch/scripts/dispatch.ts");
const p = Bun.spawn([process.execPath, real, ...a], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
process.exit(await p.exited);
