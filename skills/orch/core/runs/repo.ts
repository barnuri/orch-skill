// Which repo a node's job runs in. The job's cwd is the repo, so a dispatch that orch starts itself (heal, gap nodes,
// verifiers, retries, advance) must never fall back to the cwd of the service process.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLedger } from "../commands/req.ts";
import { readNodeField } from "../state/node-files.ts";

/** Git toplevel of a directory, or null when it is not inside a git work tree. */
export function gitToplevel(dir: string): string | null {
  if (!dir || !existsSync(dir)) return null;
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

const repoOf = (run: any, id: string): string => String((run.nodes ?? []).find((n: any) => n.id === id)?.repo ?? "");

/** The repo a node's last job recorded in its job dir (`jobs/<id>/repo`): nodes dispatched before `repo` was kept on the node have only this. */
function jobRepoOf(home: string, run: any, id: string, runId = ""): string {
  const n = (run.nodes ?? []).find((x: any) => x.id === id);
  // attempts live in runs/<id>/nodes/<node>/ since the state split; older runs keep them in state.json.
  let attempts: any[] = Array.isArray(n?.attempts) ? n.attempts : [];
  if (attempts.length === 0 && runId) {
    try {
      const stored = readNodeField(home, runId, id, "attempts");
      if (Array.isArray(stored)) attempts = stored as any[];
    } catch { /* no node files */ }
  }
  const jobs = [n?.job_id, ...attempts.map((a) => a?.job_id)].filter((j): j is string => typeof j === "string" && j !== "");
  for (const job of jobs.reverse()) {
    try {
      const repo = readFileSync(join(home, "jobs", job, "repo"), "utf8").trim();
      if (repo) return repo;
    } catch { /* no repo file for this job */ }
  }
  return "";
}

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
  // Older runs: the jobs of the same nodes recorded their cwd. A run whose nodes all worked in one repo uses it.
  for (const id of [nodeId, ...related]) {
    const r = jobRepoOf(home, run, id, runId);
    if (r) return { repo: r, from: `job of ${id}` };
  }
  const runRepo = String(run.repo ?? "");
  return runRepo ? { repo: runRepo, from: "run" } : { repo: "", from: "" };
}
