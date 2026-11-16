// `run advance`: one scheduler step (sync, apply a finished plan, dispatch ready nodes), optionally looped.
// Ported from lib/runs/plan.sh (run_advance_once, cmd_run_advance). `run sync` still runs through dispatch.sh
// until it is ported.
import { join } from "node:path";
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { loadProfilesDoc, maxParallelCapFrom } from "../state/settings.ts";
import { findNode } from "../runs/node.ts";
import { nodeReady } from "./run.ts";
import { nodeDispatchStored } from "./dispatch.ts";
import { planApply } from "./plan.ts";
import { runFinish } from "./dispatch.ts";
import { resolveRun } from "./node.ts";

export const RUN_ADVANCE_USAGE = "dispatch.sh run advance <run-id> [--until-done] [--interval SECS] [--timeout SECS] [--no-finish]";
const ADVANCE_INTERVAL_DEFAULT = 15;

const out = (s: string) => void process.stdout.write(s);
const err = (s: string) => void process.stderr.write(s);

async function runSync(runId: string): Promise<boolean> {
  const dispatch = process.env.ORCH_DISPATCH || join(import.meta.dir, "../../scripts/dispatch.sh");
  const p = Bun.spawn(["bash", dispatch, "run", "sync", runId], { stdin: "ignore", stdout: "ignore", stderr: "inherit", env: process.env as Record<string, string> });
  return (await p.exited) === 0;
}

const count = (run: any, ...st: string[]) => (run.nodes ?? []).filter((n: any) => st.includes(n.status)).length;

async function advanceOnce(home: string, runId: string): Promise<number> {
  if (!(await runSync(runId))) return 1;
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
  let slots = maxParallelCapFrom(doc) - count(run, "running");
  const dispatched: string[] = [];
  const queued: string[] = [];
  const manual: string[] = [];
  for (const n of run.nodes.filter((x) => nodeReady(run, x))) {
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
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--until-done") untilDone = true;
    else if (a === "--interval") interval = args[++i] ?? "";
    else if (a === "--timeout") timeout = args[++i] ?? "";
    else if (a === "--no-finish") finish = false;
    else return (err(`run advance: unknown argument ${a}\n  usage: ${RUN_ADVANCE_USAGE}\n`), 2);
  }
  if (!/^[0-9]+$/.test(interval) || Number(interval) < 1 || !/^[0-9]+$/.test(timeout)) {
    return (err("run advance: --interval expects >= 1 and --timeout >= 0 seconds\n"), 2);
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
        const w = process.stdout.write.bind(process.stdout);
        (process.stdout as any).write = (s: string) => ((last = String(s).trim().split("\n").pop() ?? last), true);
        try {
          await runFinish([runId]);
        } finally {
          (process.stdout as any).write = w;
        }
        out(`finished: ${last}\n`);
      }
      return 0;
    }
    if (rc === 3) return 3;
    if (!untilDone) return 0;
    if (Number(timeout) > 0 && elapsed >= Number(timeout)) {
      err(`advance: timed out after ${timeout}s (run still active)\n`);
      return 124;
    }
    await Bun.sleep(Number(interval) * 1000);
    elapsed += Number(interval);
  }
}
