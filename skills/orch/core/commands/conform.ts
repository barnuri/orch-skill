// Plan conformance: a node that is tied to a plan task (node.plan = {file, task}) must only change the files
// the plan gives that task (its files_touched). The changes are the commits its job added (start_commit .. HEAD of
// the node's repo). A change outside the plan is a deviation: the coordinator updates the plan or asks the user.
import { existsSync, readFileSync } from "node:fs";
import { loadRun } from "../state/store.ts";
import { paths } from "../state/home.ts";
import { join } from "node:path";

export interface PlanTask { id: string; files: string[] }

// Reads a plan.md table: a row whose first cell is the task id (e.g. T9) and a files_touched or files cell.
export function planTasks(text: string): PlanTask[] {
  const out: PlanTask[] = [];
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""));
    if (cells.length < 2) continue;
    const id = cells[0]!.replace(/[*`]/g, "");
    if (!/^T\d+$/.test(id)) continue;
    const files = (cells.slice(1).join(" ").match(/[\w./-]+\.(rs|ts|tsx|js|md|yml|yaml|toml|json|sh|html|css|mjs|py)/g) ?? []).map((f) => f.replace(/^\.\//, ""));
    out.push({ id, files });
  }
  return out;
}

// Files changed by the node's job: from its start commit to HEAD, in the repo the job ran in.
export async function changedFiles(home: string, runId: string, nodeId: string): Promise<string[]> {
  const jobDir = await jobDirOf(home, runId, nodeId);
  if (!jobDir) return [];
  const repo = readFileSync(join(jobDir, "repo"), "utf8").trim();
  const start = existsSync(join(jobDir, "start_commit")) ? readFileSync(join(jobDir, "start_commit"), "utf8").trim() : "";
  if (!repo || !start) return [];
  const p = Bun.spawn(["git", "-C", repo, "diff", "--name-only", `${start}..HEAD`], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function jobDirOf(home: string, runId: string, nodeId: string): Promise<string | null> {
  const run = await loadRun(home, runId);
  const n = (run?.nodes ?? []).find((x: any) => x.id === nodeId);
  const job = n?.job_id;
  if (!job) return null;
  const dir = join(paths.jobs(home), String(job));
  return existsSync(dir) ? dir : null;
}

// Deviations: changed files that are not in the plan task's files. Empty when the node conforms.
export async function conformance(home: string, runId: string, nodeId: string, planFile: string, taskId: string): Promise<{ ok: boolean; outside: string[]; task: string }> {
  if (!existsSync(planFile)) return { ok: false, outside: [`plan file missing: ${planFile}`], task: taskId };
  const task = planTasks(readFileSync(planFile, "utf8")).find((t) => t.id === taskId);
  if (!task) return { ok: false, outside: [`task ${taskId} not in plan`], task: taskId };
  const changed = await changedFiles(home, runId, nodeId);
  const allowed = new Set(task.files);
  const outside = changed.filter((f) => !allowed.has(f) && ![...allowed].some((a) => f.endsWith(a)));
  return { ok: outside.length === 0, outside, task: taskId };
}
