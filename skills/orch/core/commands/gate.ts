// `run gate <run-id>`: the watchdog's close step for a run whose orchestrator is gone, run without an agent.
// There is no gate node: when every node is settled it runs `run verify` (plus the gap check). Pass: `run finish`.
// Fail: the run is marked blocked (`needs_user` and `notice` hold the numbered failures, `review` the structured
// list), one message goes to the next orchestrator (`node tell coordinator`), and the run stays open.
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import { runFinish } from "./dispatch.ts";
import { formatFailures, verifyRun } from "./verify.ts";

export const RUN_GATE_USAGE = "dispatch.ts run gate <run-id>";
export const GATE_FAIL_PREFIX = "verify FAILED";
const SETTLED = new Set(["done", "skipped", "covered"]);

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const w = process.stdout.write;
  (process.stdout as any).write = () => true;
  try { return await fn(); } finally { (process.stdout as any).write = w; }
};

export async function runGateCmd(args: string[]): Promise<number> {
  if (args.length !== 1) return (errLine(`usage: ${RUN_GATE_USAGE}`), 2);
  const home = orchHome();
  const runId = await resolveRun(home, args[0]!);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (run.status !== "running" || run.nodes.length === 0) {
    process.stdout.write(`gate: not ready (${runId})\n`);
    return 0;
  }
  const open = run.nodes.filter((n) => !SETTLED.has(n.status));
  if (open.length > 0) {
    process.stdout.write(`gate: not ready, open nodes: ${open.map((n) => n.id).join(",")}\n`);
    return 0;
  }
  const fails = await verifyRun(home, runId, run);
  if (fails.length === 0) {
    const { findGaps } = await import("./gaps.ts");
    for (const g of await findGaps(home, runId)) fails.push({ nodes: [g.id], msg: `gap: ${g.kind} ${g.id}`, hint: `dispatch.ts run heal ${runId}` });
  }
  if (fails.length === 0) {
    const stale = run.needs_user != null || run.notice != null || run.review != null;
    if (stale) {
      const rc = await mutateRun(home, runId, (r) => { r.needs_user = null; r.notice = null; r.review = null; });
      if (rc !== 0) return rc;
    }
    process.stdout.write(`gate: passed (${runId})\n`);
    return quiet(() => runFinish([runId]));
  }
  const text = `${GATE_FAIL_PREFIX}: ${fails.length} failure(s) in ${runId}\n${formatFailures(fails)}`.trim();
  const rc = await mutateRun(home, runId, (r, ctx) => {
    r.needs_user = text;
    r.notice = text;
    r.review = { state: "failed", at: ctx.now, failures: fails.map((f) => ({ nodes: f.nodes, msg: f.msg, hint: f.hint })) };
  });
  if (rc !== 0) return rc;
  const { cmdNodeTell } = await import("./inbox.ts");
  await quiet(() => cmdNodeTell([runId, "coordinator", `The run is blocked: verify failed and waits for you. ${text}`, "--from", "watchdog"]));
  process.stdout.write(`gate: blocked, ${fails.length} failure(s) (${runId})\n`);
  return 1;
}
