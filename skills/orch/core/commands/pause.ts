// `run pause | resume | stop | set | guard` and `node cancel`. Port of lib/runs/pause.sh.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { pidAlive, sleep } from "../state/proc.ts";
import { closeJobTab } from "../adapters/herdr.ts";
import { ev, findNode, segClose, setStatus } from "../runs/node.ts";
import { mutateRun } from "./node.ts";
import { dispatchNodeJob } from "./dispatch.ts";
import { coordinatorRecord, coordinatorAutoRecord, coordSweep } from "./inbox.ts";
import { healthMonitorAutostart } from "./health.ts";

const RUN_PAUSE_USAGE = "dispatch.ts run pause <run-id>";
const RUN_RESUME_USAGE = "dispatch.ts run resume <run-id> [--stopped]";
const RUN_STOP_USAGE = "dispatch.ts run stop <run-id>";
const RUN_SET_USAGE = "dispatch.ts run set <run-id> auto_dispatch true|false";
const COORD_USAGE = "dispatch.ts run set <run-id> coordinator   (run in the coordinator pane: HERDR_PANE_ID, HERDR_SOCKET_PATH set)";
const NODE_CANCEL_USAGE = "dispatch.ts node cancel <run-id> <node-id>";
const STOP_GRACE = () => Number(process.env.RUN_STOP_GRACE ?? 5);

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const note = (ctx: any, text: string) => ev(ctx, "note", "", "", "", text);

async function requireRun(home: string, id: string) {
  const r = await loadRun(home, id);
  if (!r) err(`run ${id}: unknown run\n`);
  return r;
}

// pause_guard: prints "run stopped" or "run paused" and returns 3 when the run is either.
export async function pauseGuard(home: string, run: string, toErr = false): Promise<number> {
  const out = toErr ? err : (x: string) => process.stdout.write(x);
  if (!run) return 0;
  const r = await loadRun(home, run);
  if (r?.stopped === true) return (out(`run stopped: ${run} (dispatch.ts run resume ${run} --stopped)\n`), 3);
  if (r?.paused === true) return (out(`run paused: ${run} (dispatch.ts run resume ${run})\n`), 3);
  return 0;
}

export const runGuard = (args: string[]) => pauseGuard(orchHome(), args[0] ?? "");

export async function runPause(args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) return (err(`usage: ${RUN_PAUSE_USAGE}\n`), 2);
  const home = orchHome();
  if (!(await requireRun(home, args[0]))) return 2;
  const rc = await mutateRun(home, args[0], (r, ctx) => {
    r.paused = true;
    r.auto_resume = true;
    r.paused_at = ctx.now;
    note(ctx, "run paused");
  });
  if (rc === 0) out(`paused: ${args[0]}\n`);
  return rc;
}

export async function runSet(args: string[]): Promise<number> {
  const [run = "", key = "", value = ""] = args;
  if (!run || !key) return (err(`usage: ${RUN_SET_USAGE}\n  or: ${COORD_USAGE}\n`), 2);
  const home = orchHome();
  if (key === "coordinator" && args.length === 2) {
    if (!(await requireRun(home, run))) return 2;
    return coordinatorRecord(home, run);
  }
  if (args.length !== 3 || key !== "auto_dispatch") return (err(`run set: unknown key ${key}\n  usage: ${RUN_SET_USAGE}\n`), 2);
  if (value !== "true" && value !== "false") return (err("run set: auto_dispatch must be true or false\n"), 2);
  if (!(await requireRun(home, run))) return 2;
  const rc = await mutateRun(home, run, (r, ctx) => {
    r.auto_dispatch = value === "true";
    note(ctx, `auto_dispatch ${value}`);
  });
  if (rc === 0) out(`auto_dispatch: ${run} ${value}\n`);
  return rc;
}

function jobPid(home: string, job: string): number {
  try {
    return Number(readFileSync(join(paths.jobs(home), job, "pid"), "utf8").replace(/\s/g, "")) || 0;
  } catch {
    return 0;
  }
}

// SIGTERM to the job's process group, a check for the grace period, then SIGKILL. True when it was alive.
export async function stopKillJob(home: string, job: string): Promise<boolean> {
  const pid = job ? jobPid(home, job) : 0;
  if (!pid || !pidAlive(pid)) return false;
  const sig = (s: NodeJS.Signals) => { try { process.kill(-pid, s); } catch { try { process.kill(pid, s); } catch { /* gone */ } } };
  sig("SIGTERM");
  for (let i = 0; pidAlive(pid) && i < STOP_GRACE() * 10; i++) await sleep(100);
  if (pidAlive(pid)) sig("SIGKILL");
  await closeJobTab(home, join(paths.jobs(home), job));
  return true;
}

export async function runStop(args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) return (err(`usage: ${RUN_STOP_USAGE}\n`), 2);
  const [run] = args;
  const home = orchHome();
  const st = await requireRun(home, run);
  if (!st) return 2;
  let rc = await mutateRun(home, run, (r, ctx) => {
    r.stopped = true;
    r.auto_resume = false;
    r.stopped_at = ctx.now;
  });
  if (rc !== 0) return 1;
  let killed = 0;
  for (const n of st.nodes.filter((x) => x.status === "running")) {
    if (n.job_id && (await stopKillJob(home, String(n.job_id)))) killed++;
  }
  rc = await mutateRun(home, run, (r, ctx) => {
    for (const n of r.nodes) {
      if (n.status !== "running") continue;
      segClose(n, ctx.now);
      n.finished_at = ctx.now;
      n.status = "stopped";
      n.stopped_at = ctx.now;
      n.next_retry_at = null;
    }
    note(ctx, "run stopped");
  });
  if (rc !== 0) return 1;
  out(`stopped: ${run} (killed ${killed} job(s))\n`);
  return 0;
}

async function redispatch(home: string, run: string, node: any): Promise<boolean> {
  const id = node.id;
  const prompt = String(node.prompt ?? "");
  if (!prompt) return (err(`resume: ${id} has no recorded prompt, left as running\n`), false);
  const target = node.profile ? ["--profile", String(node.profile)] : node.adapter ? [String(node.adapter)] : [];
  if (target.length === 0) return (err(`resume: ${id} has no profile or adapter, left as running\n`), false);
  const extra = ((node.dispatch_args ?? []) as string[]).filter((a) => a !== "");
  const rc0 = await mutateRun(home, run, (r) => { findNode(r, id)!.status = "waiting"; });
  if (rc0 !== 0) return false;
  const res = await dispatchNodeJob(home, run, id, [...target, prompt, ...extra], { resume: String(node.session ?? "") });
  if (res.rc !== 0) return false;
  out(`redispatched: ${id} ${res.jobId}\n`);
  return true;
}

export async function runResume(args: string[]): Promise<number> {
  const run = args[0] ?? "";
  if (!run) return (err(`usage: ${RUN_RESUME_USAGE}\n`), 2);
  const rest = args.slice(1);
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--stopped")) return (err(`usage: ${RUN_RESUME_USAGE}\n`), 2);
  const force = rest.length === 1;
  const home = orchHome();
  const st = await requireRun(home, run);
  if (!st) return 2;
  if (st.stopped === true && !force) {
    err(`run resume: ${run} was stopped by a user; resume it with --stopped (the run page Resume button)\n`);
    return 3;
  }
  const rc = await mutateRun(home, run, (r, ctx) => {
    const from = r.paused_at ?? r.stopped_at;
    if (from != null && from < ctx.now) r.pauses = [...(r.pauses ?? []), { from, to: ctx.now }];
    r.paused = false;
    r.auto_resume = false;
    r.paused_at = null;
    r.stopped = false;
    r.stopped_at = null;
    note(ctx, "run resumed");
  });
  if (rc !== 0) return 1;
  out(`resumed: ${run}\n`);
  let code = 0;
  for (const n of st.nodes.filter((x) => x.status === "running" || x.status === "stopped")) {
    const pid = n.job_id ? jobPid(home, String(n.job_id)) : 0;
    if (pid && pidAlive(pid)) {
      out(`alive: ${n.id} ${n.job_id}\n`);
      continue;
    }
    if (!(await redispatch(home, run, n))) code = 1;
  }
  return code;
}

export async function nodeCancel(args: string[]): Promise<number> {
  const [run = "", node = ""] = args;
  if (!run || !node || args.length !== 2) return (err(`usage: ${NODE_CANCEL_USAGE}\n`), 2);
  const home = orchHome();
  const st = await requireRun(home, run);
  if (!st) return 2;
  const n = findNode(st, node);
  if (!n) return (err(`node ${node}: not in this run\n`), 2);
  if (n.status !== "running") return (err(`node cancel: ${node} is ${n.status}, not running\n`), 3);
  const killed = n.job_id ? await stopKillJob(home, String(n.job_id)) : false;
  const rc = await mutateRun(home, run, (r, ctx) => setStatus(r, node, "stopped", "", "", "", "", ctx));
  if (rc !== 0) return 1;
  out(killed ? `cancelled: ${node} (job killed)\n` : `cancelled: ${node} (no live job)\n`);
  return 0;
}

// Hidden helpers for the bash that still calls the old lib functions (run create hooks, run sync guard, wait loop).
export async function runUtil(args: string[]): Promise<number> {
  const [verb = "", run = ""] = args;
  const home = orchHome();
  const r = run ? await loadRun(home, run) : null;
  switch (verb) {
    case "guard": return pauseGuard(home, run);
    case "paused": return r?.paused === true ? 0 : 1;
    case "stopped": return r?.stopped === true ? 0 : 1;
    case "auto-record": await coordinatorAutoRecord(home, run); return 0;
    case "monitor-autostart": await healthMonitorAutostart(home, run); return 0;
    case "sweep": for (const l of await coordSweep(home, run)) process.stdout.write(l + "\n"); return 0;
    default: return (err("usage: run-util guard|paused|stopped|auto-record|monitor-autostart|sweep <run-id>\n"), 2);
  }
}
