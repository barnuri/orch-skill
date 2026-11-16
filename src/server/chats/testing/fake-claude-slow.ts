#!/usr/bin/env bun
// Test double for a detached claude turn that writes slowly and survives its parent. Never calls a model.
// FAKE_SLOW_TICKS (default 12) deltas "t0 ", "t1 " ... FAKE_SLOW_SLEEP seconds apart (default 0.1), then waits for
// the FAKE_SLOW_GATE file to exist (when set) and ends with "done" and a result line. Logs its args to FAKE_AGENT_LOG.
import { appendFileSync, existsSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
let session = "fake-session";
args.forEach((a, i) => {
  if ((a === "--resume" || a === "--session-id") && i + 1 < args.length) session = args[i + 1]!;
});
const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);
const delta = (text: string) =>
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: session, parent_tool_use_id: null });

if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${args.join(" ")}\n`);
for await (const _ of Bun.stdin.stream()) break;
out({ type: "system", subtype: "init", session_id: session });
const n = Number(process.env.FAKE_SLOW_TICKS ?? 12);
const nap = Number(process.env.FAKE_SLOW_SLEEP ?? 0.1) * 1000;
for (let i = 0; i < n; i++) {
  delta(`t${i} `);
  await Bun.sleep(nap);
}
const gate = process.env.FAKE_SLOW_GATE;
while (gate && !existsSync(gate)) await Bun.sleep(50);
delta("done");
out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: { "fake-model": {} }, session_id: session });
process.exit(0);
