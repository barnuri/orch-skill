// `node reap <run> <node>`: end a finished-but-alive node. Kills only that node's job process tree, keeps the recorded
// result and handoff, and sets the node done with a reason. Also the `run sync` hook that reports such nodes once
// to the orchestrator and, when settings.reap_after_result_min is set, reaps them by itself.
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { nowIso } from "../state/clock.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { captured, out } from "../io.ts";
import { doneVerify, ev, findNode, setStatus } from "../runs/node.ts";
import { findStuckAfterResult, reapAfterResultMinutes, reapCommand, stuckAfterResultMinutes, stuckAfterResultOf } from "../runs/stuck-after-result.ts";
import { hubNodeSettle } from "../adapters/hub.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import { stopKillJob } from "./pause.ts";
import { msgSend } from "./msg.ts";

export const NODE_REAP_USAGE = 'dispatch.ts node reap <run-id> <node-id> [--reason "<text>"] [--force]';

/** Kills the node's job tree and closes the node done. The caller checked the node is running with a job. */
export async function reapNode(home: string, runId: string, nodeId: string, reason: string): Promise<{ killed: boolean; rc: number }> {
  const run = await loadRun(home, runId);
  const n = run ? findNode(run, nodeId) : null;
  const job = String(n?.job_id ?? "");
  const killed = job ? await stopKillJob(home, job) : false;
  const rc = await mutateRun(home, runId, (r, ctx) => {
    const x = findNode(r, nodeId);
    if (!x || x.status !== "running") return;
    setStatus(r, nodeId, "done", "", "", "", "", ctx);
    doneVerify(r, nodeId, ctx);
    x.reaped = { at: ctx.now, job, reason, killed };
    x.stuck_after_result = null;
    ev(ctx, "note", nodeId, "", "", `reaped: ${reason}`);
  });
  if (rc === 0) await hubNodeSettle(runId, nodeId, "done").catch(() => 0);
  return { killed, rc };
}

export async function nodeReap(args: string[]): Promise<number> {
  const pos: string[] = [];
  let reason = "";
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--reason") reason = args[++i] ?? "";
    else if (a === "--force") force = true;
    else if (a.startsWith("-")) return (errLine(`node reap: unknown argument ${a}\n  usage: ${NODE_REAP_USAGE}`), 2);
    else pos.push(a);
  }
  const [runArg = "", nodeId = ""] = pos;
  if (!runArg || !nodeId || pos.length !== 2) return (errLine(`usage: ${NODE_REAP_USAGE}`), 2);
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  const n = findNode(run, nodeId);
  if (!n) return (errLine(`node ${nodeId}: not in this run`), 2);
  if (n.status !== "running" || !n.job_id) return (errLine(`node reap refused: ${nodeId} is ${n.status}${n.job_id ? "" : " with no job"}, not a running job`), 1);
  // Any idle time counts here (minutes 0 would turn detection off, so pass 1 ms worth): the user asked for it.
  const proof = stuckAfterResultOf(home, runId, n, Date.now() + 365 * 86_400_000, 1);
  if (!proof && !force) {
    return (errLine(`node reap refused: ${nodeId} has no result or handoff for this attempt (or its job ended); use node cancel, or --force`), 1);
  }
  const why = reason || `finished but alive: ${proof?.evidence ?? "forced"} recorded, job ${n.job_id} still running`;
  const r = await reapNode(home, runId, nodeId, why);
  if (r.rc !== 0) return 1;
  out(`reaped: ${nodeId} (${r.killed ? "job killed" : "no live job"}, result kept: ${proof?.verdict || "unknown"})\n`);
  return 0;
}

/**
 * The `run sync` step: report lines for every finished-but-alive node. The first sighting of a node's job records
 * `stuck_after_result` on the node and sends one message to the orchestrator. With settings.reap_after_result_min
 * set, a node idle that long is reaped instead. A node whose log grows again loses the mark.
 */
export async function syncStuckAfterResult(home: string, runId: string): Promise<string[]> {
  const doc = await loadProfilesDoc(home);
  const minutes = stuckAfterResultMinutes(doc);
  const reapMin = reapAfterResultMinutes(doc);
  const run = await loadRun(home, runId);
  if (!run) return [];
  const now = Date.now();
  const detect = reapMin > 0 ? Math.min(minutes > 0 ? minutes : reapMin, reapMin) : minutes;
  const stuck = findStuckAfterResult(home, runId, run, now, detect);
  const ids = new Set(stuck.map((s) => s.node));
  const cleared = run.nodes.filter((n) => n.stuck_after_result && n.status === "running" && !ids.has(String(n.id))).map((n) => String(n.id));
  if (cleared.length) {
    await mutateRun(home, runId, (r) => {
      for (const id of cleared) {
        const x = findNode(r, id);
        if (x) x.stuck_after_result = null;
      }
    });
  }
  const lines: string[] = [];
  for (const s of stuck) {
    if (reapMin > 0 && s.idleMin >= reapMin) {
      const r = await reapNode(home, runId, s.node, `auto-reap: finished but alive, idle ${s.idleMin} min (settings.reap_after_result_min ${reapMin})`);
      lines.push(`reaped-after-result: ${s.node} idle ${s.idleMin} min${r.rc === 0 ? "" : " (failed)"}`);
      continue;
    }
    const cmd = reapCommand(runId, s.node);
    lines.push(`stuck-after-result: ${s.node} idle ${s.idleMin} min (job ${s.job}): ${cmd}`);
    const prev = findNode(run, s.node)?.stuck_after_result;
    if (prev && prev.job === s.job) continue;
    const since = nowIso(new Date(Math.floor((now - s.idleMin * 60_000) / 1000) * 1000));
    await mutateRun(home, runId, (r, ctx) => {
      const x = findNode(r, s.node);
      if (!x) return;
      x.stuck_after_result = { job: s.job, since, idle_min: s.idleMin, evidence: s.evidence, noted_at: ctx.now };
      ev(ctx, "note", s.node, "", "", `stuck after result: ${s.evidence} recorded, job ${s.job} alive, log idle ${s.idleMin} min`);
    });
    const text = `node ${s.node} is finished but alive: its ${s.evidence} is recorded, job ${s.job} still runs and its log has been idle ${s.idleMin} min (likely a background or --watch command). Fix: ${cmd}`;
    const sent = await captured({}, () => msgSend([runId, "--to", "orch", "--from", "orch", text]));
    if (sent.code !== 0) errLine(`stuck-after-result: message to orch failed: ${sent.stderr.trim()}`);
  }
  return lines;
}
