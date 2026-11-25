// `run heal`: keeps a running run moving without a person. For each running run: it creates the
// missing work (open requests, gaps) and reports `ready-to-verify` when every node is satisfied. It never closes the run.
// Safe to call often: it does nothing when there is nothing to do.
import { orchHome } from "../state/home.ts";
import { readdirSync, existsSync } from "node:fs";
import { loadRun } from "../state/store.ts";
import { paths } from "../state/home.ts";
import { nodeSatisfied } from "./run.ts";
import { loadLedger, REQ_OK } from "./req.ts";

export const RUN_HEAL_USAGE = "dispatch.ts run heal [<run-id>]";

// Routine step: requirements whose linked nodes are all done with a full result become implemented, then an independent
// verifier node is created for each; a passing verifier closes it, a failing one reopens it with gap nodes.
export async function recordRoutineEvidence(home: string, runId: string): Promise<number> {
  const { advanceRequirements } = await import("./req-flow.ts");
  return (await advanceRequirements(home, runId)).length;
}

export async function healRun(home: string, runId: string): Promise<string> {
  const run = await loadRun(home, runId);
  if (!run || run.status !== "running") return "skip";
  const work = run.nodes ?? [];
  if (work.length === 0) return "skip";
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
  // Closing is the orchestrator's step (`run verify`, then `run finish`), or the watchdog's when the orchestrator is gone.
  return "ready-to-verify";
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
