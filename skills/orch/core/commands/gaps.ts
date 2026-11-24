// Gap finder for the done gate. A run is not done while it has gaps: a user request that is not handled,
// a node in error that has no replacement, or a done node with no recorded result. For each gap the finder
// creates one node that does the missing work (a new node with a full prompt), so the run keeps going.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../state/store.ts";
import { paths, orchHome } from "../state/home.ts";
import { loadLedger } from "./req.ts";
import { mutateRun } from "./node.ts";
import { planTasks } from "./conform.ts";

export interface Gap { kind: "request" | "errored-node" | "no-result" | "deviation" | "handoff-missing"; id: string; detail: string; scope?: boolean }

const BIN = join(import.meta.dir, "..", "..", "scripts", "dispatch.ts");

// A deviation changes scope when an out-of-plan file belongs to no task of the plan. A file that another plan
// task owns is a fix across the plan's own files, not a new scope.
function changesScope(planFile: string, outside: string[]): boolean {
  if (!existsSync(planFile)) return false;
  const known = planTasks(readFileSync(planFile, "utf8")).flatMap((t) => t.files);
  return outside.some((f) => !known.some((k) => f === k || f.endsWith(k)));
}

const gapNodeId = (g: Gap): string => `gap-${g.id}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60);

export async function findGaps(home: string, runId: string): Promise<Gap[]> {
  const run = await loadRun(home, runId);
  if (!run) return [];
  const gaps: Gap[] = [];
  const statusOf = new Map((run.nodes ?? []).map((n: any) => [n.id, String(n.status ?? "")]));
  for (const r of (await loadLedger(home, runId)).requirements ?? []) {
    // Only open and in-progress requirements need implementation work; implemented and verifying ones are in the verification flow.
    if (!["open", "in_progress"].includes(String(r.status))) continue;
    // A linked node that is still working, or done and waiting for the requirement step, already owns the request.
    const linked = ((r as any).nodes ?? []).map((id: string) => statusOf.get(id) ?? "");
    if (linked.some((s: string) => ["waiting", "ready", "running", "stale", "done"].includes(s))) continue;
    gaps.push({ kind: "request", id: String(r.id), detail: String(r.text ?? r.id) });
  }
  const ids = new Set((run.nodes ?? []).map((n: any) => n.id));
  for (const n of run.nodes ?? []) {
    if (n.id === "done-gate") continue;
    if (n.status === "error" && !(run.nodes ?? []).some((m: any) => m.status === "covered" && String(m.covered_by ?? "").endsWith(`/${n.id}`))) {
      gaps.push({ kind: "errored-node", id: n.id, detail: String(n.error ?? "error") });
    }
    if (n.error === "ended early without handoff") gaps.push({ kind: "handoff-missing", id: n.id, detail: "agent output exists but handoff.md is missing" });
    if (n.status === "done" && (!n.result || n.result.verdict === "unknown")) gaps.push({ kind: "no-result", id: n.id, detail: "done without a result" });
    // The owner stopped and the node was marked done without an orchestrator review: review it before relying on it.
    else if (n.status === "done" && n.owner_state === "finished" && n.reviewed !== true) gaps.push({ kind: "no-result", id: n.id, detail: "done because its owner stopped, unreviewed" });
  }
  // Plan conformance: a done node tied to a plan task must have changed only that task's files.
  const { conformance } = await import("./conform.ts");
  for (const n of run.nodes ?? []) {
    const pl = (n as any).plan as { file: string; task: string } | undefined;
    if (!pl || n.status !== "done") continue;
    const c = await conformance(home, runId, n.id, pl.file, pl.task);
    if (!c.ok) gaps.push({ kind: "deviation", id: n.id, detail: `changed outside plan task ${pl.task}: ${c.outside.join(", ")}`, scope: changesScope(pl.file, c.outside) });
  }
  void ids;
  return gaps;
}

// Creates one node per gap that has no node yet. Returns the ids created.
export async function createGapNodes(home: string, runId: string, gaps: Gap[]): Promise<string[]> {
  const created: string[] = [];
  const run = await loadRun(home, runId);
  // A scope-changing deviation is a question for the user: the node's needs_user holds it until the coordinator asks and clears it.
  for (const g of gaps) {
    if (g.kind !== "deviation" || !g.scope) continue;
    const dev = (run?.nodes ?? []).find((n: any) => n.id === g.id) as any;
    if (!dev || dev.needs_user || (run?.nodes ?? []).some((n: any) => n.id === gapNodeId(g))) continue;
    const question = `Node ${g.id} changed a scope outside its plan (${g.detail}). Keep the change and update the plan, or revert it?`;
    await mutateRun(home, runId, (s: any) => { const x = s.nodes.find((n: any) => n.id === g.id); if (x) x.needs_user = question; });
  }
  for (const g of gaps) {
    if (g.kind === "errored-node") continue; // the watch replaces errored nodes itself (node replace)
    const id = gapNodeId(g);
    if ((run?.nodes ?? []).some((n: any) => n.id === id)) continue;
    const label = g.kind === "request" ? `Handle request ${g.id}: ${g.detail}` : g.kind === "deviation" ? `Reconcile ${g.id} with the plan (${g.detail})` : `Record a real result for ${g.id} (${g.detail})`;
    const prompt = g.kind === "deviation"
      ? `Node ${g.id} changed files outside its plan task: ${g.detail}. Decide: if the change is needed, update the plan (the plan file and its files_touched) and record the decision; if not, revert the out-of-plan change. If the decision changes scope, say so in handoff.md: the orchestrator asks the user, not you. Then write handoff.md and record a result.`
      : g.kind === "request"
      ? `Handle this user request in full in this repository: "${g.detail}". Verify it with tests or evidence, write handoff.md into $ORCH_NODE_OUT, then record a result.`
      : g.kind === "handoff-missing"
      ? `Recover node ${g.id}: inspect its final job transcript and result, write the missing $ORCH_NODE_OUT/handoff.md, then continue every verified gap as separate orch nodes. Record ${g.id} as partial when the original work is incomplete, and never claim a full result from chat text alone.`
      : `Node ${g.id} finished without a verified result. Check its work, fix anything missing, write handoff.md into $ORCH_NODE_OUT, then record a result for ${g.id} with dispatch.ts node result.`;
    const gapEnv = { ...process.env, HARNESS_ORCH_HOME: home };
    const add = Bun.spawn([process.execPath, BIN, "node", "add", runId, id, label, "--profile", "opencode-chip-exec", "--model", "hub-copilot-mai-code-2-flash", "--role", "implementation"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gapEnv });
    await add.exited;
    if (add.exitCode !== 0) continue;
    const run2 = Bun.spawn([process.execPath, BIN, "node", "dispatch", runId, id, "--force", prompt], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gapEnv });
    await run2.exited;
    created.push(id);
  }
  return created;
}

export const gapsHome = (): string => orchHome();
void readdirSync; void existsSync; void paths;
