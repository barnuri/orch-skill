// `run settle <run> --reason T [--commit SHA] [--accept-partial]`: close a run whose work was finished outside its nodes
// (main-session takeover). Unfinished nodes become skipped, handoff-stale done nodes are accepted, open requirements are
// marked handled with the reason and commit as evidence. Nothing is deleted; every change is recorded in the reason fields.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../state/lock.ts";
import { paths } from "../state/home.ts";
import { handoffProblem } from "../runs/node.ts";
import { orchHome } from "../state/home.ts";
import { loadRun, saveRun, writeJsonAtomic } from "../state/store.ts";
import { resolveRun, errLine } from "./node.ts";
import { loadLedger, reqFile, REQ_OK } from "./req.ts";

export const RUN_SETTLE_USAGE = "dispatch.ts run settle <run-id> --reason T [--commit SHA] [--accept-partial]";

export async function runSettle(args: string[]): Promise<number> {
  const home = orchHome();
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  let acceptPartial = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--accept-partial") acceptPartial = true;
    else if (a === "--reason" || a === "--commit") flags[a] = args[++i] ?? "";
    else if (a.startsWith("--")) return (errLine(`run settle: unknown flag ${a}\n  usage: ${RUN_SETTLE_USAGE}`), 2);
    else pos.push(a);
  }
  if (pos.length !== 1 || !flags["--reason"]) return (errLine(`usage: ${RUN_SETTLE_USAGE}`), 2);
  const runId = await resolveRun(home, pos[0]!);
  if (runId === null) return 2;
  const lock = await acquireLock(home, `run-${runId}`, 400, 50);
  if (!lock) return (errLine(`run ${runId}: state is locked by another writer`), 75);
  const reqLock = await acquireLock(home, `req-${runId}`, 400, 50);
  if (!reqLock) {
    await lock.release();
    return (errLine(`run ${runId}: requirements are locked by another writer`), 75);
  }
  try {
    const run = await loadRun(home, runId);
    if (!run) return (errLine(`run ${runId}: unknown run`), 2);
    const reason = flags["--reason"]!;
    const commit = flags["--commit"] ?? "";
    const note = commit ? `${reason} (commit ${commit})` : reason;
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let skipped = 0;
    let accepted = 0;
    for (const node of run.nodes as any[]) {
      if (node.status === "done" || node.status === "skipped") {
        const handoffFile = join(typeof node.out_dir === "string" && node.out_dir !== "" ? node.out_dir : paths.runOutDir(home, runId, String(node.id)), "handoff.md");
        if (acceptPartial && node.status === "done" && (node.unverified === true || (node.result && node.result.verdict !== "full") || handoffProblem(handoffFile, node) !== "")) {
          node.unverified = false;
          node.result = { ...(node.result ?? {}), follow_up: "none", settled_follow_up: node.result?.follow_up ?? null, settled: note };
          // A stale handoff makes verify call the node unverified; the acceptance note is a real, dated edit of it.
          const dir = typeof node.out_dir === "string" && node.out_dir !== "" ? node.out_dir : paths.runOutDir(home, runId, String(node.id));
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, "handoff.md"), `\n\n---\nAccepted ${now} by run settle: ${note}\n`);
          accepted++;
        }
        continue;
      }
      if (node.id === "done-gate") continue; // the gate runs verify itself: `run advance` after settle
      if (node.role === "validation") {
        // A validation node must pass: the main session ran the checks itself, so it closes as done with the evidence in its handoff.
        const dir = typeof node.out_dir === "string" && node.out_dir !== "" ? node.out_dir : paths.runOutDir(home, runId, String(node.id));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "handoff.md"), `# ${node.id}\n\nClosed by run settle at ${now}.\n\n${note}\n`);
        node.status = "done";
        node.finished_at = now;
        node.unverified = false;
        node.result = { verdict: "full", summary: `settled by the main session: ${note}`.slice(0, 300), follow_up: "none", settled: note };
        skipped++;
        continue;
      }
      node.status = "skipped";
      node.skip_reason = `settled: ${note}`;
      node.unverified = false;
      skipped++;
    }
    await saveRun(home, runId, run);
    const ledger = await loadLedger(home, runId);
    let handled = 0;
    for (const req of ledger.requirements) {
      if (REQ_OK.includes(req.status)) continue;
      req.status = "handled";
      req.reason = note;
      req.evidence.push({ note, file: null, test: null, at: now });
      req.updated = now;
      handled++;
    }
    await writeJsonAtomic(reqFile(home, runId), ledger);
    process.stdout.write(`settled ${runId}: ${skipped} nodes skipped, ${accepted} accepted, ${handled} requirements handled\n`);
    return 0;
  } finally {
    await reqLock.release();
    await lock.release();
  }
}
