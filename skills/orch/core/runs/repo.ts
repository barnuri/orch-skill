// Which repo a node's job runs in. The job's cwd is the repo, so a dispatch that orch starts itself (heal, gap nodes,
// verifiers, retries, advance) must never fall back to the cwd of the service process.
import { existsSync } from "node:fs";
import { loadLedger } from "../commands/req.ts";

/** Git toplevel of a directory, or null when it is not inside a git work tree. */
export function gitToplevel(dir: string): string | null {
  if (!dir || !existsSync(dir)) return null;
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

const repoOf = (run: any, id: string): string => String((run.nodes ?? []).find((n: any) => n.id === id)?.repo ?? "");

/**
 * Order: the node's own last repo, then its parent (`after`) nodes and the nodes linked to it through a requirement
 * (or the nodes in `hint`), then the run's repo. Returns "" when none is known.
 */
export async function resolveNodeRepo(home: string, runId: string, run: any, nodeId: string, hint: string[] = []): Promise<{ repo: string; from: string }> {
  const own = repoOf(run, nodeId);
  if (own) return { repo: own, from: "node" };
  const related = new Set<string>(hint);
  for (const [from, to] of (run.edges ?? []) as Array<[string, string]>) if (to === nodeId) related.add(from);
  const ledger = await loadLedger(home, runId).catch(() => ({ requirements: [] as any[] }));
  for (const r of ledger.requirements ?? []) {
    const ids: string[] = [...(r.nodes ?? []), ...(r.implemented_by ?? [])];
    if (ids.includes(nodeId) || r.verifier === nodeId) for (const id of ids) related.add(id);
  }
  related.delete(nodeId);
  for (const id of related) {
    const r = repoOf(run, id);
    if (r) return { repo: r, from: `node ${id}` };
  }
  const runRepo = String(run.repo ?? "");
  return runRepo ? { repo: runRepo, from: "run" } : { repo: "", from: "" };
}
