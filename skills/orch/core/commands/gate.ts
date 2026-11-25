// `run gate <run-id>`: the deterministic done-gate, run without an agent. Called by the watchdog when every node
// except the done-gate is settled. Pass: gate done (verify output as handoff and result), then `run finish`.
// Fail: gate blocked-user with the numbered failures as reason and handoff, the run stays open, one message to the
// orchestrator (`node tell coordinator`, which also notifies). `node dispatch` of the gate stays available.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { errLine } from "./node.ts";
import { resolveRun, nodeUpdate, nodeResult } from "./node.ts";
import { nodeOutDir, runFinish } from "./dispatch.ts";
import { GATE_ID, formatFailures, verifyRun } from "./verify.ts";

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
  const gate = run.nodes.find((n) => n.id === GATE_ID);
  const retry = gate?.status === "blocked-user" && String((gate as any).needs_user ?? "").startsWith(GATE_FAIL_PREFIX);
  if (run.status !== "running" || !gate || (gate.status !== "waiting" && !retry)) {
    process.stdout.write(`gate: not ready (${runId})\n`);
    return 0;
  }
  const open = run.nodes.filter((n) => n.id !== GATE_ID && !SETTLED.has(n.status));
  if (open.length > 0) {
    process.stdout.write(`gate: not ready, open nodes: ${open.map((n) => n.id).join(",")}\n`);
    return 0;
  }
  if (retry) {
    const back = await nodeUpdate([runId, GATE_ID, "waiting", "--clear-needs-user"]);
    if (back !== 0) return back;
  }
  let rc = await nodeUpdate([runId, GATE_ID, "running", "--owner", "scheduler"]);
  if (rc !== 0) return rc;
  const fresh = (await loadRun(home, runId))!;
  const fails = await verifyRun(home, runId, fresh);
  if (fails.length === 0) {
    const { findGaps } = await import("./gaps.ts");
    const gaps = await findGaps(home, runId);
    if (gaps.length > 0) {
      for (const g of gaps) fails.push({ nodes: [g.id], msg: `gap: ${g.kind} ${g.id}`, hint: `dispatch.ts run heal ${runId}` });
    }
  }
  const text = fails.length === 0 ? `verify ok: ${runId}\n` : `${GATE_FAIL_PREFIX}: ${fails.length} failure(s) in ${runId}\n${formatFailures(fails)}`;
  const dir = await nodeOutDir(home, runId, GATE_ID, fresh);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "handoff.md"), text);
  if (fails.length === 0) {
    rc = await nodeResult([runId, GATE_ID, "--verdict", "full", "--summary", `verification passed: ${text.trim()}`, "--follow-up", "none"]);
    if (rc !== 0) return rc;
    rc = await nodeUpdate([runId, GATE_ID, "done"]);
    if (rc !== 0) return rc;
    process.stdout.write(`gate: passed (${runId})\n`);
    return quiet(() => runFinish([runId]));
  }
  rc = await nodeUpdate([runId, GATE_ID, "blocked-user", "--needs-user", text.trim()]);
  if (rc !== 0) return rc;
  const { cmdNodeTell } = await import("./inbox.ts");
  await quiet(() => cmdNodeTell([runId, "coordinator", `The done-gate failed and waits for you. ${text.trim()}`, "--from", "watchdog"]));
  process.stdout.write(`gate: blocked, ${fails.length} failure(s) (${runId})\n`);
  return 1;
}
