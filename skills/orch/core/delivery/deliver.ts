// Delivery supervisor: merges a queued group into one integration worktree, runs checks, delivers, and records evidence.
// Deterministic. Never stashes, rebases, force-pushes or resets the user's checkout. Every step is idempotent: a commit
// already on the target is skipped, so a run after a restart continues where the last one stopped.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadQueue, saveQueue, groupQueue, type DeliveryEntry, type DeliveryGroup, type DeliveryMode, type DeliveryQueue } from "./queue.ts";

export interface GitResult { code: number; out: string; err: string }
export type Runner = (cwd: string, cmd: string[]) => Promise<GitResult>;

export const spawnRunner: Runner = async (cwd, cmd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
};

export interface Step { name: string; ok: boolean; detail: string }
export interface Evidence {
  group: string;
  repo: string;
  mode: DeliveryMode;
  outcome: "delivered" | "refused" | "failed" | "blocked";
  entries: string[];
  refused: string[];
  steps: Step[];
  head: string;
  pr_url: string | null;
  at: string;
}

export interface DeliverOpts {
  home: string;
  runner?: Runner;
  now: string;
  /** Checks run in the integration worktree, each one a command. A non-zero exit fails the group. */
  checks?: string[][];
  /** The repo's default branch name. */
  defaultBranch: string;
  /** Opens a PR for a pushed branch. Returns the PR URL. Injected so tests never call gh. */
  openPr?: (cwd: string, branch: string, title: string, base: string) => Promise<string>;
}

const evidenceDir = (home: string) => join(home, "delivery", "evidence");
const workDir = (home: string, id: string) => join(home, "delivery", "work", id.replace(/[^\w.-]+/g, "_"));

// Commits of a group entry not yet on the integration head. A commit counts as applied when it is an ancestor of
// HEAD, or when git cherry finds an equivalent patch (same patch-id) already on HEAD: cherry-pick creates new SHAs.
async function pending(run: Runner, dir: string, commits: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of commits) {
    const anc = await run(dir, ["git", "merge-base", "--is-ancestor", c, "HEAD"]);
    if (anc.code === 0) continue;
    const cherry = await run(dir, ["git", "cherry", "HEAD", c]);
    const lines = cherry.out.split("\n").filter(Boolean);
    if (cherry.code === 0 && lines.length > 0 && lines.every((l) => l.startsWith("-"))) continue;
    out.push(c);
  }
  return out;
}


// Runs one group. Returns the evidence and writes it under <home>/delivery/evidence/.
export async function deliverGroup(group: DeliveryGroup, entries: DeliveryEntry[], opts: DeliverOpts): Promise<Evidence> {
  const run = opts.runner ?? spawnRunner;
  const repo = group.repo;
  const steps: Step[] = [];
  const refused: string[] = [];
  const ev = (outcome: Evidence["outcome"], head: string, pr: string | null): Evidence => ({
    group: group.id, repo, mode: group.mode, outcome, entries: entries.map((e) => e.key), refused, steps, head, pr_url: pr, at: opts.now,
  });
  const finish = (e: Evidence) => {
    mkdirSync(evidenceDir(opts.home), { recursive: true });
    writeFileSync(join(evidenceDir(opts.home), `${group.id.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(e, null, 2) + "\n");
    return e;
  };

  // 1. Integration worktree at the default branch. Reused on resume.
  const dir = workDir(opts.home, group.id);
  if (!existsSync(dir)) {
    const r = await run(repo, ["git", "worktree", "add", "--detach", dir, opts.defaultBranch]);
    steps.push({ name: "worktree", ok: r.code === 0, detail: r.code === 0 ? dir : r.err });
    if (r.code !== 0) return finish(ev("failed", "", null));
  } else steps.push({ name: "worktree", ok: true, detail: `reused ${dir}` });

  // 2. Cherry-pick each entry's commits. A conflicting commit is aborted and its entry is refused.
  for (const e of entries) {
    const todo = await pending(run, dir, e.commits);
    if (todo.length === 0) { steps.push({ name: `apply ${e.key}`, ok: true, detail: "already on integration head" }); continue; }
    const r = await run(dir, ["git", "cherry-pick", ...todo]);
    if (r.code !== 0) {
      await run(dir, ["git", "cherry-pick", "--abort"]);
      refused.push(e.key);
      steps.push({ name: `apply ${e.key}`, ok: false, detail: `conflict, refused: ${r.err || r.out}`.slice(0, 300) });
      continue;
    }
    steps.push({ name: `apply ${e.key}`, ok: true, detail: `${todo.length} commit(s)` });
  }
  const applied = entries.filter((e) => !refused.includes(e.key));
  if (applied.length === 0) return finish(ev("refused", "", null));

  // 3. Checks in the integration worktree. Any failure stops the group.
  for (const c of opts.checks ?? []) {
    const r = await run(dir, c);
    steps.push({ name: `check ${c.join(" ")}`, ok: r.code === 0, detail: r.code === 0 ? "ok" : (r.err || r.out).slice(-300) });
    if (r.code !== 0) return finish(ev("failed", "", null));
  }

  const head = (await run(dir, ["git", "rev-parse", "HEAD"])).out;

  // 4a. Direct: fast-forward the repo's default branch. ff-only refuses when it would touch the user's uncommitted files.
  if (group.mode === "direct") {
    const r = await run(repo, ["git", "merge", "--ff-only", head]);
    steps.push({ name: "direct ff-only", ok: r.code === 0, detail: r.code === 0 ? head : (r.err || r.out).slice(-300) });
    return finish(ev(r.code === 0 ? "delivered" : "blocked", head, null));
  }

  // 4b. PR: push the integration head to a delivery branch and open one PR for the group.
  const branch = `orch/deliver-${group.id.replace(/[^\w.-]+/g, "_")}`;
  const push = await run(dir, ["git", "push", "origin", `HEAD:refs/heads/${branch}`]);
  steps.push({ name: "push", ok: push.code === 0, detail: push.code === 0 ? branch : (push.err || push.out).slice(-300) });
  if (push.code !== 0) return finish(ev("failed", head, null));
  const title = `orch delivery: ${applied.map((e) => e.node).join(", ")}`;
  const url = opts.openPr ? await opts.openPr(dir, branch, title, opts.defaultBranch) : "";
  steps.push({ name: "pr", ok: url !== "", detail: url || "no PR opener" });
  return finish(ev(url ? "delivered" : "failed", head, url || null));
}

// Delivers every queued group. Entries of a delivered group are marked delivered and skipped on the next run.
export async function deliverPending(opts: DeliverOpts & { repoPolicy?: (repo: string) => { mode: DeliveryMode; defaultBranch: string } }): Promise<Evidence[]> {
  const q: DeliveryQueue = loadQueue(opts.home);
  const modeOf = (repo: string) => opts.repoPolicy?.(repo).mode ?? "pr";
  const { queue, groups } = groupQueue(q, modeOf);
  const results: Evidence[] = [];
  for (const g of groups) {
    const members = g.entries.map((k) => queue.entries[k]!).filter((e) => e.state !== "delivered");
    if (members.length === 0) continue;
    const branch = opts.repoPolicy?.(g.repo).defaultBranch ?? opts.defaultBranch;
    const ev = await deliverGroup(g, members, { ...opts, defaultBranch: branch });
    results.push(ev);
    const outcome = ev.outcome;
    for (const k of g.entries) {
      const e = queue.entries[k]!;
      if (ev.refused.includes(k)) queue.entries[k] = { ...e, state: "refused", refused_reason: "conflict during integration" };
      else if (outcome === "delivered") queue.entries[k] = { ...e, state: "delivered" };
      else queue.entries[k] = { ...e, state: "queued" };
    }
    saveQueue(opts.home, queue);
  }
  return results;
}

