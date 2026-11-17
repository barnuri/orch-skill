#!/usr/bin/env bun
// Show a job's profile, exit code and log tail. Replaces `J=$(ls -td ~/.harness-orch/jobs/<prefix>*/ | head -1); cat $J/exit_code; tail -c 400 $J/log`.
// Usage: bun scripts/job-tail.ts [job-id-or-prefix | --node <node-id> [--run <run-id>]] [--bytes N]
// Without a selector it shows the newest job. --node reads the job id recorded on the node in state.json.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, readState, resolveRun } from "./lib/orch-run.ts";

const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const bytes = Number(opt("--bytes") ?? 600);
const jobsDir = join(orchHome(), "jobs");
const read = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "");

let job: string | undefined;
const nodeId = opt("--node");
if (nodeId !== undefined) {
  const node = (readState(resolveRun(opt("--run"))).nodes ?? []).find((n) => n.id === nodeId);
  if (!node?.job) { console.error(`node ${nodeId}: no job recorded`); process.exit(1); }
  job = node.job;
} else {
  const skip = new Set(["--bytes", "--run"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const prefix = args.find((a, i) => !a.startsWith("--") && !skip.has(i)) ?? "";
  job = readdirSync(jobsDir).filter((d) => d.startsWith(prefix)).sort().pop();
  if (job === undefined) { console.error(`no job matches "${prefix}"`); process.exit(1); }
}

const dir = join(jobsDir, job);
const logFile = existsSync(join(dir, "log.plain")) ? "log.plain" : "log";
const log = read(dir, logFile);
console.log(`job ${job} profile=${read(dir, "profile") || "?"} exit=${read(dir, "exit_code") || "running"}`);
console.log(log.slice(-bytes));
