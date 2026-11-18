#!/usr/bin/env bun
// Short coordinator wrapper for dispatch.ts. Replaces the pasted
// `unset HARNESS_ORCH_HOME; o(){ timeout 150 bun .../dispatch.ts "$@"; }; N=$(cat /tmp/orch-run-id)` preamble.
// Usage:
//   bun scripts/o.ts <dispatch args...>           an "@run" argument becomes the current run id
//   bun scripts/o.ts set <status> <node>...       node update @run <node> <status> for each node
//   --tail N                                      print only the last N output lines
//   --test-home                                   keep $HARNESS_ORCH_HOME (default: unset, so the real home is used)
// The run id comes from $ORCH_RUN_ID, then /tmp/orch-run-id, then the newest running run. 150 s timeout per call.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveRun } from "./lib/orch-run.ts";

const DISPATCH = process.env["ORCH_DISPATCH"] ?? join(import.meta.dir, "..", "skills", "orch", "scripts", "dispatch.ts");
let args = process.argv.slice(2);
const tailIdx = args.indexOf("--tail");
const tail = tailIdx >= 0 ? Number(args[tailIdx + 1]) : 0;
if (tailIdx >= 0) args.splice(tailIdx, 2);
const env = { ...process.env };
if (args.includes("--test-home")) args = args.filter((a) => a !== "--test-home");
else delete env["HARNESS_ORCH_HOME"];

function call(a: string[]): number {
  const runArgs = a.map((x) => (x === "@run" ? resolveRun("@run") : x));
  const r = spawnSync(process.execPath, [DISPATCH, ...runArgs], { env, encoding: "utf8", timeout: 150_000 });
  let out = (r.stdout ?? "") + (r.stderr ?? "");
  if (tail > 0) out = out.trimEnd().split("\n").slice(-tail).join("\n") + "\n";
  process.stdout.write(out);
  if (r.error) { console.error(String(r.error)); return 124; }
  return r.status ?? 1;
}

if (args[0] === "set") {
  const [, status, ...nodes] = args;
  if (!status || nodes.length === 0) { console.error("usage: o.ts set <status> <node>..."); process.exit(2); }
  let rc = 0;
  for (const n of nodes) if (call(["node", "update", "@run", n, status]) !== 0) { console.error(`FAILED ${status}: ${n}`); rc = 1; }
  process.exit(rc);
}
process.exit(call(args));
