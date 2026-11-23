// `run heal`: makes a run that finished its work close, without a person. For each running run: when every
// node is satisfied and the done-gate is waiting, error, or skipped, it resets the gate and lets the scheduler
// run it; when the gate is done, it finishes the run. Safe to call often: it does nothing when there is nothing to do.
import { orchHome } from "../state/home.ts";
import { readdirSync, existsSync } from "node:fs";
import { loadRun } from "../state/store.ts";
import { paths } from "../state/home.ts";
import { nodeSatisfied } from "./run.ts";
import { loadLedger, REQ_OK } from "./req.ts";

export const RUN_HEAL_USAGE = "dispatch.ts run heal [<run-id>]";

const GATE = "done-gate";

// Routine evidence: an open requirement whose linked nodes are all done with a full result is handled by that
// work. The evidence is the nodes' recorded results; nothing is answered or approved on the user's behalf.
export async function recordRoutineEvidence(home: string, runId: string): Promise<number> {
  const run = await loadRun(home, runId);
  if (!run) return 0;
  const { reqEvidence, reqStatus } = await import("./req.ts");
  let recorded = 0;
  for (const r of (await loadLedger(home, runId)).requirements ?? []) {
    if (REQ_OK.includes(String(r.status)) || !Array.isArray(r.nodes) || r.nodes.length === 0) continue;
    const linked = r.nodes.map((id: string) => (run.nodes ?? []).find((n: any) => n.id === id));
    if (!linked.every((n: any) => n && n.status === "done" && n.result?.verdict === "full")) continue;
    const note = `nodes ${r.nodes.join(", ")} done with a full result (routine evidence)`;
    if ((await reqEvidence([runId, String(r.id), "--note", note])) !== 0) continue;
    if ((await reqStatus([runId, String(r.id), "handled"])) === 0) recorded++;
  }
  return recorded;
}

export async function healRun(home: string, runId: string): Promise<string> {
  const run = await loadRun(home, runId);
  if (!run || run.status !== "running") return "skip";
  const gate = (run.nodes ?? []).find((n: any) => n.id === GATE);
  const work = (run.nodes ?? []).filter((n: any) => n.id !== GATE);
  if (!gate) return "skip";
  if (gate.status === "done") {
    const { runFinish } = await import("./dispatch.ts");
    const rc = await runFinish([runId]);
    return rc === 0 ? "finished" : "finish-refused";
  }
  await recordRoutineEvidence(home, runId);
  // Never close a run whose requests are not recorded and handled: a run with no ledger proves nothing.
  const ledger = (await loadLedger(home, runId)).requirements ?? [];
  if (ledger.length === 0) return "needs-requirements";
  if (ledger.some((r) => !REQ_OK.includes(String(r.status)))) {
    // Open requests: create the missing work as nodes so the run keeps moving.
    const { findGaps, createGapNodes } = await import("./gaps.ts");
    const made = await createGapNodes(home, runId, (await findGaps(home, runId)).filter((g) => g.kind === "request"));
    return `requirements-open:${made.join(",") || "none-new"}`;
  }
  if (!work.every((n: any) => nodeSatisfied(run, n))) return "waiting-work";
  // Gaps: a request not handled, or a done node with no result. Create the missing work as new nodes instead of closing.
  const { findGaps, createGapNodes } = await import("./gaps.ts");
  const gaps = (await findGaps(home, runId)).filter((g) => g.kind !== "errored-node");
  if (gaps.length) {
    const made = await createGapNodes(home, runId, gaps);
    return `gaps-created:${made.join(",") || "none-new"}`;
  }
  if (gate.status === "running") return "gate-running";
  const { nodeUpdate } = await import("./node.ts");
  if (gate.status !== "waiting") await nodeUpdate([runId, GATE, "waiting", "--force"]);
  const { runAdvance } = await import("./advance.ts");
  await runAdvance([runId]);
  return "gate-advanced";
}

export async function runHeal(args: string[]): Promise<number> {
  const home = orchHome();
  const all = existsSync(paths.runs(home)) ? readdirSync(paths.runs(home)) : [];
  const ids = args[0] && !args[0].startsWith("--") ? [args[0]] : all;
  for (const id of ids) process.stdout.write(`${id}: ${await healRun(home, id)}\n`);
  // Learn from the runs on every pass: refresh the orch-fix suggestions quietly.
  const { suggestLearn } = await import("./learn.ts");
  await suggestLearn(["--quiet"]);
  return 0;
}
