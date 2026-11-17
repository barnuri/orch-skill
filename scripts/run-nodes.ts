#!/usr/bin/env bun
// Node status of a run, grouped by status. Replaces inline `jq '.nodes[]' state.json | awk` one-offs.
// Usage: bun scripts/run-nodes.ts [run-id|@run] [--open | --running | --status <s>] [--json]
//   default      one line per status: "running(2): a b"
//   --open       nodes not done and not skipped, "id status" per line
//   --running    ids of running nodes on one line
//   --status s   ids with status s on one line
// The run id defaults to $ORCH_RUN_ID, then /tmp/orch-run-id, then the newest running run.
import { readState, resolveRun } from "./lib/orch-run.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const statusIdx = args.indexOf("--status");
const wanted = statusIdx >= 0 ? args[statusIdx + 1] : flag("--running") ? "running" : undefined;
const run = resolveRun(args.find((a, i) => !a.startsWith("--") && i !== statusIdx + 1));
const state = readState(run);
const nodes = state.nodes ?? [];

if (flag("--json")) {
  console.log(JSON.stringify({ run, status: state.status, paused: state.paused ?? false, nodes: nodes.map(({ id, status }) => ({ id, status })) }));
} else if (wanted !== undefined) {
  console.log(nodes.filter((n) => n.status === wanted).map((n) => n.id).join(" "));
} else if (flag("--open")) {
  for (const n of nodes) if (n.status !== "done" && n.status !== "skipped") console.log(`${n.id} ${n.status}`);
} else {
  const groups = new Map<string, string[]>();
  for (const n of nodes) groups.set(n.status, [...(groups.get(n.status) ?? []), n.id]);
  console.log(`run ${run} ${state.status ?? "?"}${state.paused ? " (paused)" : ""}, ${nodes.length} nodes`);
  for (const [s, ids] of [...groups].sort()) console.log(`${s}(${ids.length}): ${ids.join(" ")}`);
}
