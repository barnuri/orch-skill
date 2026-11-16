#!/usr/bin/env bun
// Test double for `dispatch.ts run --profile P @promptfile`. Never calls a model.
import { appendFileSync, readFileSync } from "node:fs";

const a = process.argv.slice(2);
if (a[0] !== "run") {
  console.error(`unexpected: ${a.join(" ")}`);
  process.exit(2);
}
const prompt = readFileSync((a[3] ?? "").replace(/^@/, ""), "utf8");
const log = process.env.FAKE_AGENT_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({ profile: a[2], model_id: process.env.ORCH_MODEL_ID ?? "", resume: process.env.ORCH_RESUME_SESSION ?? "", session: process.env.ORCH_SESSION_ID ?? "", cwd: process.cwd() }) + "\n");
}
if (prompt.includes("FAIL")) {
  console.error("boom");
  process.exit(4);
}
if (prompt.includes("SLOW")) {
  for (;;) {
    process.stdout.write("tick ");
    await Bun.sleep(50);
  }
}
process.stdout.write(`turn-echo: ${prompt.split("\n")[0]}`);
