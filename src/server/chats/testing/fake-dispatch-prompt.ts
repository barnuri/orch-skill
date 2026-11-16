#!/usr/bin/env bun
// Test double for `dispatch.ts run --profile P @promptfile` on a harness with no session (local-llm).
// Answers with the number of characters it was sent and logs the whole prompt. Never calls a model.
import { appendFileSync, readFileSync } from "node:fs";

const a = process.argv.slice(2);
if (a[0] !== "run") {
  console.error(`unexpected: ${a.join(" ")}`);
  process.exit(2);
}
const prompt = readFileSync((a[3] ?? "").replace(/^@/, ""), "utf8").replace(/\n+$/, "");
if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, `${prompt}\n=====\n`);
process.stdout.write(`chars=${prompt.length}`);
