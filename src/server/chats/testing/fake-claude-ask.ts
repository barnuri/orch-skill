#!/usr/bin/env bun
// Test double for `claude -p --input-format stream-json`: a prompt with ASK makes the model call AskUserQuestion
// (as real claude does in -p mode the tool errors at once and the model goes on), then it streams until killed.
// A prompt with "[Answer to your question]" is echoed back and the turn ends. Never calls a model.
import { appendFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
let session = "fake-session";
args.forEach((a, i) => {
  if ((a === "--resume" || a === "--session-id") && i + 1 < args.length) session = args[i + 1]!;
});
const log = process.env.FAKE_AGENT_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, args })}\n`);
const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);
const delta = (text: string) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: session, parent_tool_use_id: null });

let buf = "";
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
}
const text = (JSON.parse(buf.split("\n")[0]!) as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
if (log) appendFileSync(log, `${JSON.stringify({ prompt: text })}\n`);
out({ type: "system", subtype: "init", session_id: session });
if (text.includes("ASK")) {
  out({
    type: "assistant", message: { model: "fake-model", content: [{
      type: "tool_use", id: "toolu_ask1", name: "AskUserQuestion",
      input: { questions: [{ question: "Which color?", header: "Pick", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] },
    }] },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask1", is_error: true, content: "non-interactive" }] } });
  for (;;) { delta("assuming red "); await Bun.sleep(50); }
}
delta(`got: ${text.replace(/\n/g, " | ")}`);
out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "fake-model": {} }, session_id: session });
