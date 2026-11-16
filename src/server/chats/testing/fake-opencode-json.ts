#!/usr/bin/env bun
// Test double for `opencode run --format json --auto [--session <id>] [-m <model>] [-f <file>]... <prompt>`.
// One file per session in $FAKE_STATE; replies "turns=N" in one text part, then a step_finish. Event shape from opencode 2.3.0 run.ts:
// {type,timestamp,sessionID,part|error}. A missing --session id is created (as the real CLI does) unless FAKE_REJECT_UNKNOWN=1.
// Never calls a model.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const state = process.env.FAKE_STATE;
if (!state) {
  console.error("FAKE_STATE: parameter null or not set");
  process.exit(1);
}
mkdirSync(state, { recursive: true });
const argv = process.argv.slice(2);
const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);

// `serve` (only when FAKE_SERVE=1, else it fails like a CLI without the command): records its pid, prints the
// listening line opencode 2.x prints, then answers HTTP on a free port until killed. Each start appends to
// $state/serve.pids.
if (argv[0] === "serve" && process.env.FAKE_SERVE === "1") {
  appendFileSync(join(state, "serve.pids"), `${process.pid}\n`);
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  console.log(`server listening on http://127.0.0.1:${s.port}`);
  setTimeout(() => process.exit(0), 600_000);
} else {
  await run();
}

async function run(): Promise<void> {
  if (argv[0] !== "run") process.exit(2);
  const rest = argv.slice(1);
  let sid = "";
  let prompt = "";
  let mode = "standalone";
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--session") sid = rest[++i] ?? "";
    else if (a === "--server") mode = `server:${rest[++i] ?? ""}:${process.env.OPENCODE_SERVER_PASSWORD ? "pw" : ""}`;
    else if (a === "--standalone") mode = "standalone";
    else if (a === "--format" || a === "-m") i++;
    else if (a === "-f" || a === "--file") files.push(rest[++i] ?? "");
    else if (a === "--auto") continue;
    else prompt = a;
  }
  if (mode.startsWith("server:") && process.env.FAKE_SERVER_DOWN === "1") {
    out({ type: "error", timestamp: 1, sessionID: "", error: { type: "unknown", message: "Could not reach server at http://127.0.0.1:1: ECONNREFUSED: Unable to connect." } });
    process.exit(1);
  }
  if (sid) {
    if (!existsSync(join(state!, sid))) {
      if (process.env.FAKE_REJECT_UNKNOWN === "1") {
        out({ type: "error", timestamp: 1, sessionID: sid, error: { type: "unknown", message: `Session not found: ${sid}` } });
        process.exit(1);
      }
      writeFileSync(join(state!, sid), "");
    }
  } else {
    sid = `ses_${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 32768)}`;
    writeFileSync(join(state!, sid), "");
  }
  const file = join(state!, sid);
  appendFileSync(file, `@@@\n${prompt}\n`);
  if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `opencode\t${sid}\t${prompt}\t${mode}\t${files.join(",")}\t${argv.includes("-m") ? argv[argv.indexOf("-m") + 1] : ""}\n`);
  const n = readFileSync(file, "utf8").split("\n").filter((l) => l === "@@@").length;
  const ts = 1700000000000;
  const base = { timestamp: ts, sessionID: sid };
  out({ type: "step_start", ...base, part: { id: "prt_1", sessionID: sid, messageID: "msg_1", type: "step-start" } });
  out({ type: "tool_use", ...base, part: { partID: "prt_2", sessionID: sid, messageID: "msg_1", type: "tool", id: "call_1", tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n", title: "bash", metadata: {}, time: { start: 1, end: 2 } } } });
  if (process.env.FAKE_SLOW_SECONDS) {
    out({ type: "text", ...base, part: { id: "prt_0", sessionID: sid, messageID: "msg_1", type: "text", text: "slow:", time: { start: 1, end: 2 } } });
    await Bun.sleep(Number(process.env.FAKE_SLOW_SECONDS) * 1000);
  }
  out({ type: "text", ...base, part: { id: "prt_3", sessionID: sid, messageID: "msg_1", type: "text", text: `turns=${n}`, time: { start: 1, end: 2 } } });
  out({ type: "step_finish", ...base, part: { id: "prt_4", sessionID: sid, messageID: "msg_1", type: "step-finish", reason: "stop", cost: 0.002, tokens: { total: 14, input: 11, output: 3, reasoning: 0, cache: { write: 0, read: 0 } } } });
  process.exit(0);
}
