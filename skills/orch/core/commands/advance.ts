// `run advance`: one scheduler step (sync, apply a finished plan, dispatch ready nodes), optionally looped.
// Ported from lib/runs/plan.sh (run_advance_once, cmd_run_advance). `run sync` still runs through dispatch.ts
// runs in-process (stdout muted, pause answered by run sync itself as in bash).
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { loadProfilesDoc, maxParallelCapFrom, runCapFrom } from "../state/settings.ts";
import { findNode } from "../runs/node.ts";
import { nodeReady } from "./run.ts";
import { nodeDispatchStored, nodeOutDir } from "./dispatch.ts";
import { planApply } from "./plan.ts";
import { runFinish } from "./dispatch.ts";
import { resolveRun, nodeUpdate, nodeResult } from "./node.ts";
import { runSync as runSyncCmd } from "./runs.ts";
import { GATE_ID, formatFailures, verifyRun } from "./verify.ts";

export const RUN_ADVANCE_USAGE = "dispatch.ts run advance <run-id> [--until-done] [--interval SECS] [--timeout SECS] [--no-finish] [--stop-on blocked|error|timeout|all]";
const ADVANCE_INTERVAL_DEFAULT = 15;

const out = (s: string) => void process.stdout.write(s);
const err = (s: string) => void process.stderr.write(s);

async function syncQuiet(runId: string): Promise<boolean> {
  const w = process.stdout.write;
  (process.stdout as any).write = () => true;
  try {
    return (await runSyncCmd([runId])) === 0;
  } finally {
    (process.stdout as any).write = w;
  }
}

const count = (run: any, ...st: string[]) => (run.nodes ?? []).filter((n: any) => st.includes(n.status)).length;

// The done-gate has no agent and no profile. The scheduler runs the verify check itself, writes its result as
// the gate's handoff, then marks the gate done (no failures) or error (failures). Returns 1 only when a node update fails.
async function runGate(home: string, runId: string): Promise<number> {
  if ((await nodeUpdate([runId, GATE_ID, "running", "--owner", "scheduler"])) !== 0) return 1;
  const run = (await loadRun(home, runId))!;
  const fails = await verifyRun(home, runId, run);
  const text = fails.length === 0 ? `verify ok: ${runId}\n` : `verify FAILED: ${fails.length} failure(s) in ${runId}\n${formatFailures(fails)}`;
  const dir = await nodeOutDir(home, runId, GATE_ID, run);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "handoff.md"), text);
  const { findGaps } = await import("./gaps.ts");
  const gaps = await findGaps(home, runId);
  if (fails.length === 0 && gaps.length > 0) {
    // Gaps are not done: the gate stays open and the heal creates the missing work.
    return nodeUpdate([runId, GATE_ID, "error", "--error", `${gaps.length} gap(s): ${gaps.map((g) => g.kind + " " + g.id).join(", ")}`]);
  }
  if (fails.length === 0) {
    // The gate records its own result, so verify sees a result for it.
    const result = await nodeResult([runId, GATE_ID, "--verdict", "full", "--summary", "verification passed", "--follow-up", "none"]);
    if (result !== 0) return result;
    return nodeUpdate([runId, GATE_ID, "done"]);
  }
  return nodeUpdate([runId, GATE_ID, "error", "--error", `${fails.length} verify failure(s): run verify ${runId}`]);
}

async function advanceOnce(home: string, runId: string): Promise<number> {
  if (!(await syncQuiet(runId))) return 1;
  // Requirements move along every pass: finished work -> implemented -> independent verifier -> done, or gap nodes.
  try {
    const { advanceRequirements } = await import("./req-flow.ts");
    await advanceRequirements(home, runId);
  } catch {
    // A failed requirement step never stops the scheduler; the next pass retries it.
  }
  let run = (await loadRun(home, runId))!;
  const planNode = run.plan?.node ?? "";
  if (planNode !== "" && !run.plan?.applied) {
    const st = findNode(run, planNode)?.status;
    if (st === "done") {
      if ((await planApply([runId])) !== 0) return 1;
    } else if (st === "error") {
      err(`advance: planner node ${planNode} failed — see orch node digest ${runId} ${planNode}\n`);
      return 1;
    }
    run = (await loadRun(home, runId))!;
  }
  const doc = await loadProfilesDoc(home);
  let slots = runCapFrom(maxParallelCapFrom(doc), run.max_parallel) - count(run, "running");
  const dispatched: string[] = [];
  const queued: string[] = [];
  const manual: string[] = [];
  const gated: string[] = [];
  for (const n of run.nodes.filter((x) => nodeReady(run, x))) {
    if (n.id === GATE_ID) {
      if ((await runGate(home, runId)) !== 0) return 1;
      gated.push(n.id);
      continue;
    }
    const pf = join(home, "runs", runId, "prompts", `${n.id}.md`);
    const prompt = (await Bun.file(pf).exists()) ? `@${pf}` : String(n.prompt ?? "");
    if (prompt === "") {
      manual.push(n.id);
      continue;
    }
    if (slots <= 0) {
      queued.push(n.id);
      continue;
    }
    if ((await nodeDispatchStored(home, runId, n.id, prompt)).rc !== 0) return 1;
    dispatched.push(n.id);
    slots--;
  }
  run = (await loadRun(home, runId))!;
  out(`dispatched: ${dispatched.join(",")}\nqueued: ${queued.join(",")}\n`);
  if (gated.length) out(`gate run by scheduler: ${gated.join(",")}\n`);
  if (manual.length) out(`needs-prompt: ${manual.join(",")}\n`);
  out(`running: ${count(run, "running")}  waiting: ${count(run, "waiting")}  done: ${count(run, "done", "skipped")}  error: ${count(run, "error")}\n`);
  if (dispatched.length === 0 && count(run, "running") === 0 && count(run, "waiting") > 0) {
    out(`blocked: ${run.nodes.filter((n) => n.status === "waiting").map((n) => n.id).join(",")}\n`);
    return 3;
  }
  return 0;
}

export async function runAdvance(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (runArg === "") return (err(`usage: ${RUN_ADVANCE_USAGE}\n`), 2);
  let untilDone = false;
  let interval = String(ADVANCE_INTERVAL_DEFAULT);
  let timeout = "0";
  let finish = true;
  let stopOn = "all";
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--until-done") untilDone = true;
    else if (a === "--interval") interval = args[++i] ?? "";
    else if (a === "--timeout") timeout = args[++i] ?? "";
    else if (a === "--no-finish") finish = false;
    else if (a === "--stop-on") stopOn = args[++i] ?? "";
    else return (err(`run advance: unknown argument ${a}\n  usage: ${RUN_ADVANCE_USAGE}\n`), 2);
  }
  if (!/^[0-9]+$/.test(interval) || Number(interval) < 1 || !/^[0-9]+$/.test(timeout)) {
    return (err("run advance: --interval expects >= 1 and --timeout >= 0 seconds\n"), 2);
  }
  if (!["blocked", "error", "timeout", "all"].includes(stopOn)) {
    return (err("run advance: --stop-on must be blocked, error, timeout, or all\n"), 2);
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  let elapsed = 0;
  for (;;) {
    const rc = await advanceOnce(home, runId);
    if (rc === 1) return 1;
    const run = (await loadRun(home, runId))!;
    if (count(run, "waiting", "running") === 0 && run.nodes.length > 0) {
      if (finish && run.status === "running") {
        let last = "";
        let frc = 0;
        const w = process.stdout.write.bind(process.stdout);
        (process.stdout as any).write = (s: string) => ((last = String(s).trim().split("\n").pop() ?? last), true);
        try {
          frc = await runFinish([runId]);
        } finally {
          (process.stdout as any).write = w;
        }
        if (frc === 0) out(`finished: ${last}\n`);
        else err(`advance: run not finished, fix the failures above (run verify ${runId})\n`);
        return frc === 0 ? 0 : 1;
      }
      return 0;
    }
    if (rc === 3) {
      if (stopOn === "blocked" || stopOn === "all") return 3;
      if (!untilDone) return 0;
      await Bun.sleep(Number(interval) * 1000);
      elapsed += Number(interval);
      continue;
    }
    if (!untilDone) return 0;
    if (Number(timeout) > 0 && elapsed >= Number(timeout)) {
      err(`advance: timed out after ${timeout}s (run still active)\n`);
      return 124;
    }
    await Bun.sleep(Number(interval) * 1000);
    elapsed += Number(interval);
  }
}
