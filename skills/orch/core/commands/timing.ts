// `node started`, `run backfill-timing`, and the timing helpers. Port of lib/runs/timing.sh.
// A node is "starting" while status == running, seg_open == true and started_at == null.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "../state/clock.ts";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, type RunState } from "../state/store.ts";
import { ev, findNode, type Ctx } from "../runs/node.ts";
import { mutateRun, resolveRun } from "./node.ts";

export const NODE_STARTED_USAGE = "node started <run-id> <node-id> [--at ISO] [--source S]";
export const RUN_BACKFILL_TIMING_USAGE = "run backfill-timing [<run-id>]";

// seg_close($at): closes the open segment into run_segments (jq TIMING_JQ_DEFS).
export function segClose(n: Record<string, any>, at: string): void {
  if (!(n.seg_open ?? false)) return;
  if (!(n.started_at == null && (n.dispatched_at ?? at) >= at)) {
    n.run_segments = [...(n.run_segments ?? []), { dispatched: n.dispatched_at ?? null, start: n.started_at ?? null, end: at }];
  }
  n.seg_open = false;
}

export function markStartedIn(run: RunState, ctx: Ctx, node: string, at: string, source: string): boolean {
  const n = findNode(run, node);
  if (!n || n.status !== "running" || !(n.seg_open ?? false) || n.started_at != null) return false;
  n.started_at = n.dispatched_at != null && at < n.dispatched_at ? n.dispatched_at : at;
  ev(ctx, "started", node, "starting", "running", source);
  return true;
}

export async function nodeMarkStarted(home: string, runId: string, node: string, at: string, source: string): Promise<number> {
  return mutateRun(home, runId, (run, ctx) => {
    markStartedIn(run, ctx, node, at || ctx.now, source);
  });
}

export async function nodeStarted(args: string[]): Promise<number> {
  const home = orchHome();
  const runArg = args[0] ?? "", node = args[1] ?? "";
  if (!runArg || !node) { process.stderr.write(`usage: ${NODE_STARTED_USAGE}\n`); return 2; }
  let at = "", source = "cli";
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] === "--at") at = args[i + 1] ?? "";
    else if (args[i] === "--source") source = args[i + 1] ?? "";
    else { process.stderr.write(`usage: ${NODE_STARTED_USAGE}\n`); return 2; }
  }
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) { process.stderr.write(`run ${runId}: unknown run\n`); return 2; }
  if (!findNode(run, node)) { process.stderr.write(`node ${node}: not in this run\n`); return 2; }
  return nodeMarkStarted(home, runId, node, at, source);
}

function jobLogStart(home: string, job: string): string {
  if (!job) return "";
  try {
    const st = statSync(join(paths.jobs(home), job, "log"));
    if (st.size === 0) return "";
    const ms = st.birthtimeMs;
    return ms > 0 ? nowIso(new Date(ms)) : "";
  } catch {
    return "";
  }
}

export async function runBackfillTiming(args: string[]): Promise<number> {
  const home = orchHome();
  const runId = args[0] ?? "";
  if (!runId) {
    for (const d of existsSync(paths.runs(home)) ? readdirSync(paths.runs(home)) : []) {
      if (existsSync(paths.runState(home, d))) await runBackfillTiming([d]);
    }
    return 0;
  }
  const pre = await loadRun(home, runId);
  if (!pre) { process.stderr.write(`run ${runId}: unknown run\n`); return 2; }
  const evf = paths.runEvents(home, runId);
  const events: any[] = existsSync(evf)
    ? readFileSync(evf, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  let count = 0;
  const code = await mutateRun(home, runId, (run) => {
    count = 0;
    for (const n of run.nodes) {
      if (!(n.dispatched_at == null && n.run_segments == null && n.started != null)) continue;
      const d = n.started as string;
      n.dispatched_at = d;
      const logStart = jobLogStart(home, n.job_id ?? "");
      const ownerAt = events.find((e) => e.node === n.id && e.kind === "owner" && ["started", "alive", "idle", "finished"].includes(e.to ?? "") && (e.at ?? "") >= d)?.at ?? null;
      const cands = [
        n.job_id == null ? d : null,
        (n.session_stats?.created ?? "") >= d ? n.session_stats.created : null,
        ownerAt,
        logStart === "" ? null : logStart,
      ].filter((x): x is string => typeof x === "string").sort();
      const s = cands[0] ?? null;
      n.started_at = s === null ? null : s < d ? d : s;
      if (n.status === "running") { n.seg_open = true; n.finished_at = null; }
      else if (n.finished != null) {
        n.finished_at = n.finished;
        n.seg_open = false;
        n.run_segments = [{ dispatched: n.dispatched_at, start: n.started_at, end: n.finished }];
      } else { n.seg_open = false; n.run_segments = []; }
      count++;
    }
  });
  if (code !== 0) return code;
  process.stdout.write(`backfill-timing: ${runId} ${count} node(s)\n`);
  return 0;
}
