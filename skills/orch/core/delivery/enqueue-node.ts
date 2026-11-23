// Enqueues a node's delivery facts (repo, branch, worktree, commits, touched files) from its job directory.
// Reads git only. A node with no start commit, no commits or no job directory enqueues nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../state/store.ts";
import { paths } from "../state/home.ts";
import { enqueue, loadQueue, saveQueue, type DeliveryEntry } from "./queue.ts";

async function git(repo: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return p.exitCode === 0 ? out.trim() : "";
}

export async function enqueueNode(home: string, runId: string, nodeId: string, now: string): Promise<DeliveryEntry | null> {
  const run = await loadRun(home, runId);
  const node = (run?.nodes ?? []).find((x: any) => x.id === nodeId);
  if (!node?.job_id) return null;
  const jobDir = join(paths.jobs(home), String(node.job_id));
  const repoFile = join(jobDir, "repo");
  const startFile = join(jobDir, "start_commit");
  if (!existsSync(repoFile) || !existsSync(startFile)) return null;
  const repo = readFileSync(repoFile, "utf8").trim();
  const start = readFileSync(startFile, "utf8").trim();
  if (!repo || !start) return null;

  const commits = (await git(repo, ["log", "--reverse", "--format=%H", `${start}..HEAD`])).split("\n").filter(Boolean);
  if (commits.length === 0) return null;
  const touched = (await git(repo, ["diff", "--name-only", `${start}..HEAD`])).split("\n").filter(Boolean);
  const branch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const worktree = await git(repo, ["rev-parse", "--show-toplevel"]);

  const q = loadQueue(home);
  const { queue, entry } = enqueue(q, { run: runId, node: nodeId, repo, branch, worktree, commits, touched }, now);
  if (queue !== q) saveQueue(home, queue);
  return entry;
}
