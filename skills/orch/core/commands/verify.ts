// `run verify <run-id>`: the final gate. Prints a numbered failure list and exits 0 only when clean.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, readJson, type RunState } from "../state/store.ts";
import { errLine, resolveRun } from "./node.ts";
import { needsFollowUp, resultText } from "../runs/node.ts";
import { handoffProblemOf, reqProblems } from "./req.ts";

export const GATE_ID = "done-gate";
export const RUN_VERIFY_USAGE = "dispatch.ts run verify <run-id>";
export interface Failure { nodes: string[]; msg: string; hint: string }

async function openAsks(home: string, runId: string): Promise<Failure[]> {
  const dir = join(paths.runs(home), runId, "inbox", "orch");
  const names = await readdir(dir).catch(() => [] as string[]);
  const fails: Failure[] = [];
  for (const f of names.filter((n) => n.endsWith(".json")).sort()) {
    const m: any = await readJson(join(dir, f)).catch(() => null);
    if (m && m.kind === "ask" && m.answer == null) {
      fails.push({ nodes: [String(m.from ?? "")], msg: `open ask ${m.id ?? f} from ${m.from}: ${String(m.text ?? "").slice(0, 120)}`, hint: `dispatch.ts node answer ${runId} ${m.from} "<answer>"` });
    }
  }
  return fails;
}

export async function verifyRun(home: string, runId: string, run: RunState): Promise<Failure[]> {
  const fails: Failure[] = [];
  // The gate node runs this check itself, so it is judged only once it is done.
  // A gate that is skipped is never judged away: it fails below unless it ran.
  const nodes = run.nodes.filter((n) => !(n.id === GATE_ID && n.status !== "done" && n.status !== "skipped"));
  for (const n of nodes) {
    if (n.status === "done") continue;
    if (n.status === "skipped") {
      const why = typeof n.skip_reason === "string" ? n.skip_reason.trim() : "";
      if (n.id === GATE_ID) fails.push({ nodes: [n.id], msg: `the done-gate was skipped${why ? ` (${why})` : " with no recorded reason"}; it must run`, hint: `dispatch.ts node update ${runId} ${GATE_ID} waiting --force, then let it run verify` });
      else if (!why) fails.push({ nodes: [n.id], msg: `node ${n.id} was skipped with no recorded reason`, hint: `dispatch.ts node update ${runId} ${n.id} skipped --force --reason "<why>"` });
      continue;
    }
    if (n.status === "covered") {
      // A covered node is handled when the node that replaced it (covered_by) is done.
      const ref = String((n as { covered_by?: string }).covered_by ?? "");
      const target = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
      if (target !== "" && nodes.some((x) => x.id === target && x.status === "done")) continue;
    }
    fails.push({ nodes: [n.id], msg: `node ${n.id} is ${n.status}, not done or skipped${n.error ? ` (${String(n.error).slice(0, 120)})` : ""}`, hint: ["error", "stopped"].includes(n.status) ? `dispatch.ts node retry ${runId} ${n.id}, or dispatch.ts node update ${runId} ${n.id} skipped --force --reason "<why>"` : "wait for it, or dispatch.ts run advance " + runId });
  }
  for (const n of nodes.filter((x) => x.status === "done")) {
    const hp = handoffProblemOf(home, runId, n);
    if (hp === "stale") {
      const handoffReason = typeof n.handoff_reason === "string" ? n.handoff_reason : "handoff is older than the latest attempt";
      const resultReason = typeof n.result_reason === "string" ? n.result_reason : "";
      const reason = [handoffReason, resultReason].filter(Boolean).join("; ");
      fails.push({ nodes: [n.id], msg: `node ${n.id} is unverified: ${reason}`, hint: `handoff is older than the latest attempt: rewrite $ORCH_NODE_OUT/handoff.md for ${n.id}, record the node result, then re-run: dispatch.ts node update ${runId} ${n.id} done` });
    }
    else if (hp !== "") {
      const handoffReason = hp === "empty" ? "handoff.md is empty" : "handoff.md is missing";
      const resultReason = typeof n.result_reason === "string" ? n.result_reason : "";
      const reason = [handoffReason, resultReason].filter(Boolean).join("; ");
      fails.push({ nodes: [n.id], msg: `node ${n.id} is unverified: ${reason}`, hint: `check the work, write $ORCH_NODE_OUT/handoff.md, record the node result, then re-run: dispatch.ts node update ${runId} ${n.id} done` });
    } else if (n.unverified === true) {
      const handoffReason = typeof n.handoff_reason === "string" ? n.handoff_reason : "";
      const resultReason = typeof n.result_reason === "string" ? n.result_reason : "";
      const reason = [handoffReason, resultReason].filter(Boolean).join("; ");
      fails.push({ nodes: [n.id], msg: `node ${n.id} is unverified${reason ? `: ${reason}` : ""}`, hint: `check the work, write $ORCH_NODE_OUT/handoff.md, record the node result, then re-run: dispatch.ts node update ${runId} ${n.id} done` });
    }
  }
  for (const n of nodes.filter((x) => x.status === "done" && needsFollowUp(x))) {
    fails.push({ nodes: [n.id], msg: `node ${n.id} needs follow-up: ${resultText(n, 200)}`, hint: `read $ORCH_NODE_OUT/handoff.md of ${n.id}, handle the follow-up, then record: dispatch.ts node result ${runId} ${n.id} --verdict full --summary "<what was done>"` });
  }
  for (const n of nodes.filter((x) => x.role === "validation" && x.id !== GATE_ID && x.status !== "done")) {
    fails.push({ nodes: [n.id], msg: `validation node ${n.id} did not pass (${n.status})`, hint: `fix what it found and retry: dispatch.ts node retry ${runId} ${n.id}` });
  }
  fails.push(...(await reqProblems(home, runId, run)));
  for (const n of nodes) {
    if (n.needs_user) fails.push({ nodes: [n.id], msg: `node ${n.id} needs the user: ${n.needs_user}`, hint: `ask the user, then dispatch.ts node update ${runId} ${n.id} --clear-needs-user` });
    if (n.hold) fails.push({ nodes: [n.id], msg: `node ${n.id} is on hold: ${n.hold}`, hint: `dispatch.ts node update ${runId} ${n.id} --clear-hold` });
  }
  fails.push(...(await openAsks(home, runId)));
  return fails;
}

export function formatFailures(fails: Failure[]): string {
  return fails.map((f, i) => `${i + 1}. [${f.nodes.filter(Boolean).join(",") || "run"}] ${f.msg}\n   fix: ${f.hint}\n`).join("");
}

export async function runVerify(args: string[]): Promise<number> {
  if (args.length !== 1) return (errLine(`usage: ${RUN_VERIFY_USAGE}`), 2);
  const home = orchHome();
  const runId = await resolveRun(home, args[0]!);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  const fails = await verifyRun(home, runId, run);
  if (fails.length === 0) return (process.stdout.write(`verify ok: ${runId}\n`), 0);
  process.stdout.write(`verify FAILED: ${fails.length} failure(s) in ${runId}\n${formatFailures(fails)}`);
  return 1;
}
