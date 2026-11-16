#!/usr/bin/env bun
// check-herdr-bridge.ts - sends one test ask to the live coordinator and checks it was delivered (typed into the
// coordinator pane). Usage: check-herdr-bridge.ts <run-id> [node-id]. The node must exist in the run; the default
// is its first node. Run it in the coordinator pane (HERDR_PANE_ID, HERDR_SOCKET_PATH set) after `run set coordinator`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, HOME, run, sleep } from "../lib/util.ts";

const homeDir = process.env["HARNESS_ORCH_HOME"] ?? join(HOME, ".harness-orch");
const runId = process.argv[2];
if (!runId) (console.log("usage: check-herdr-bridge.ts <run-id> [node-id]"), process.exit(2));
const statePath = join(homeDir, "runs", runId, "state.json");
if (!existsSync(statePath)) (console.log(`FAIL no run ${runId} under ${homeDir}`), process.exit(2));
const state = JSON.parse(readFileSync(statePath, "utf8"));
const node = process.argv[3] ?? state.nodes?.[0]?.id;
if (!node) (console.log(`FAIL run ${runId} has no node to ask from`), process.exit(2));
if (!state.coordinator?.pane_id) {
  console.log(`FAIL no coordinator recorded; run: dispatch.ts run set ${runId} coordinator`);
  process.exit(1);
}
const d = (...a: string[]) => run([process.execPath, DISPATCH, ...a]);
const id = d("node", "ask", runId, node, `bridge check ${new Date().toISOString().slice(11, 19)}`).out.trim().split(/\s+/)[0];
if (!id) (console.log("FAIL node ask did not store a message"), process.exit(1));
const deadline = Date.now() + 30_000;
for (;;) {
  const msgs = JSON.parse(d("run", "messages", runId, "--json").out || "[]") as { id: string; delivered_at?: string }[];
  const m = msgs.find((x) => x.id === id);
  if (m?.delivered_at) (console.log(`PASS ask ${id} from ${node} delivered at ${m.delivered_at}`), process.exit(0));
  if (Date.now() >= deadline) break;
  await sleep(2000);
}
const fresh = JSON.parse(readFileSync(statePath, "utf8"));
console.log(`FAIL ask ${id} not delivered in 30s (coordinator unreachable: ${fresh.coordinator?.unreachable?.reason ?? "none"})`);
process.exit(1);
