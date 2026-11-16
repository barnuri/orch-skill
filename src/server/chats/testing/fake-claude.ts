#!/usr/bin/env bun
// Test double for `claude -p --input-format stream-json --output-format stream-json`. Never calls a model.
// Prompt words steer it: SLOW (streams until killed), CRASH (exits 3), FAIL (is_error result), TOOL (emits a tool_use).
import { appendFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
let session = "fake-session";
args.forEach((a, i) => {
  if ((a === "--resume" || a === "--session-id") && i + 1 < args.length) session = args[i + 1]!;
});
const log = process.env.FAKE_AGENT_LOG;
if (log) {
  appendFileSync(log, `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), env: { ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "" } })}\n`);
}
const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);
const delta = (text: string) =>
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: session, parent_tool_use_id: null });
const result = (fail: boolean) =>
  out({
    type: "result",
    subtype: fail ? "error_during_execution" : "success",
    is_error: fail,
    result: fail ? "model exploded" : "ok",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 11, output_tokens: 7 },
    modelUsage: { "fake-model": {} },
    session_id: session,
  });

async function* lines(): AsyncGenerator<string> {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

let turn = 0;
for await (const line of lines()) {
  if (!line) continue;
  turn++;
  let text = line;
  const at = line.indexOf('"text":"');
  if (at >= 0) text = line.slice(at + 8);
  const end = text.indexOf('"}');
  if (end >= 0) text = text.slice(0, end);
  if (log) appendFileSync(log, `${JSON.stringify({ prompt: text })}\n`);
  out({ type: "system", subtype: "init", session_id: session });
  if (text.includes("CRASH")) process.exit(3);
  if (text.includes("TOOL")) out({ type: "assistant", message: { model: "fake-model", content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }] } });
  if (text.includes("SLOW")) for (;;) { delta("tick "); await Bun.sleep(50); }
  const nl = text.indexOf("\\n");
  const first = nl >= 0 ? text.slice(0, nl) : text;
  delta("echo:");
  delta(` ${first}`);
  delta(` (turn ${turn}, session ${session})`);
  out({ type: "assistant", message: { model: "fake-model", content: [{ type: "text", text: "ignored duplicate" }] } });
  result(text.includes("FAIL"));
}
