// Gap finder for the done gate. A run is not done while it has gaps: a user request that is not handled,
// a node in error that has no replacement, or a done node with no recorded result. For each gap the finder
// creates one node that does the missing work (a new node with a full prompt), so the run keeps going.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../state/store.ts";
import { paths, orchHome } from "../state/home.ts";
import { loadLedger, REQ_OK } from "./req.ts";

export interface Gap { kind: "request" | "errored-node" | "no-result"; id: string; detail: string }

const BIN = join(import.meta.dir, "..", "..", "scripts", "dispatch.ts");

export async function findGaps(home: string, runId: string): Promise<Gap[]> {
  const run = await loadRun(home, runId);
  if (!run) return [];
  const gaps: Gap[] = [];
  for (const r of (await loadLedger(home, runId)).requirements ?? []) {
    if (!REQ_OK.includes(String(r.status))) gaps.push({ kind: "request", id: String(r.id), detail: String(r.text ?? r.id) });
  }
  const ids = new Set((run.nodes ?? []).map((n: any) => n.id));
  for (const n of run.nodes ?? []) {
    if (n.id === "done-gate") continue;
    if (n.status === "error" && !(run.nodes ?? []).some((m: any) => m.status === "covered" && String(m.covered_by ?? "").endsWith(`/${n.id}`))) {
      gaps.push({ kind: "errored-node", id: n.id, detail: String(n.error ?? "error") });
    }
    if (n.status === "done" && (!n.result || n.result.verdict === "unknown")) gaps.push({ kind: "no-result", id: n.id, detail: "done without a result" });
  }
  void ids;
  return gaps;
}

// Creates one node per gap that has no node yet. Returns the ids created.
export async function createGapNodes(home: string, runId: string, gaps: Gap[]): Promise<string[]> {
  const created: string[] = [];
  const run = await loadRun(home, runId);
  for (const g of gaps) {
    if (g.kind === "errored-node") continue; // the watch replaces errored nodes itself (node replace)
    const id = `gap-${g.kind === "request" ? g.id : g.id}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60);
    if ((run?.nodes ?? []).some((n: any) => n.id === id)) continue;
    const label = g.kind === "request" ? `Handle request ${g.id}: ${g.detail}` : `Record a real result for ${g.id} (${g.detail})`;
    const prompt = g.kind === "request"
      ? `Handle this user request in full in this repository: "${g.detail}". Verify it with tests or evidence, write handoff.md into $ORCH_NODE_OUT, then record a result.`
      : `Node ${g.id} finished without a verified result. Check its work, fix anything missing, write handoff.md into $ORCH_NODE_OUT, then record a result for ${g.id} with dispatch.ts node result.`;
    const add = Bun.spawn([process.execPath, BIN, "node", "add", runId, id, label, "--profile", "opencode-chip-exec", "--model", "hub-copilot-mai-code-2-flash", "--role", "implementation"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await add.exited;
    if (add.exitCode !== 0) continue;
    const run2 = Bun.spawn([process.execPath, BIN, "node", "dispatch", runId, id, "--force", prompt], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await run2.exited;
    created.push(id);
  }
  return created;
}

export const gapsHome = (): string => orchHome();
void readdirSync; void existsSync; void paths;
