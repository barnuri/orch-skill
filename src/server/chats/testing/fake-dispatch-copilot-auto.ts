#!/usr/bin/env bun
// Test double for a copilot `auto` turn: writes the session log copilot writes, with the model auto routing picked.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const session = process.env.ORCH_SESSION_ID || process.env.ORCH_RESUME_SESSION || "";
const dir = join(process.env.COPILOT_HOME ?? "", "session-state", session);
mkdirSync(dir, { recursive: true });
const served = process.env.FAKE_COPILOT_SERVED ?? "";
const at = new Date().toISOString();
appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "session.model_change", data: { newModel: "auto", previousModel: "auto" }, timestamp: at })}\n`);
if (served !== "") {
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "assistant.message", data: { model: served, content: "ok" }, timestamp: at })}\n`);
}
process.stdout.write("ok");
