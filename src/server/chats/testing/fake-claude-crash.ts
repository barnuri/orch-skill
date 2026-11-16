#!/usr/bin/env bun
// Test double for a claude process that starts, streams one delta and then crashes (exit 3, message on stderr). Never calls a model.
import { writeSync } from "node:fs";

const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);
for await (const _ of Bun.stdin.stream()) break;
out({ type: "system", subtype: "init", session_id: "crash-session" });
out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } }, session_id: "crash-session", parent_tool_use_id: null });
writeSync(2, "fatal: model gpt-x is unavailable\n");
process.exit(3);
