#!/usr/bin/env bun
// Test double for claude stream-json that writes an HTML artifact in two steps (the prompt word ARTIFACT).
// It parses the chat workspace path from the instruction block, so the file lands in `<workspace>/artifacts/`.
import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);
const delta = (text: string) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: "s", parent_tool_use_id: null });

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
}

for await (const line of lines()) {
  if (!line) continue;
  out({ type: "system", subtype: "init", session_id: "s" });
  if (line.includes("ARTIFACT")) {
    const where = /This chat: (\S+?)\/ \./.exec(line)?.[1];
    const dir = join(where ?? process.cwd(), "artifacts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "page.html");
    writeFileSync(file, "<h1>First</h1>");
    out({ type: "assistant", message: { model: "fake-model", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: file, content: "<h1>First</h1>" } }] } });
    await Bun.sleep(700);
    writeFileSync(file, "<h1>Second</h1>");
    out({ type: "assistant", message: { model: "fake-model", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: file, old_string: "First", new_string: "Second" } }] } });
    await Bun.sleep(400);
  }
  delta("done");
  out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "fake-model": {} }, session_id: "s" });
}
