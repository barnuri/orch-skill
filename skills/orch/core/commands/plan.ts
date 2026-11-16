// `plan <run> "<goal>"` and `plan apply <run>`. Ported from lib/runs/plan.sh (cmd_plan, cmd_plan_apply).
// run advance stays in bash until `run sync` is ported.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowIso } from "../state/clock.ts";
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { maxParallelCapFrom, loadProfilesDoc, settingFrom, settingUintFrom } from "../state/settings.ts";
import { applyAdd, findNode, ID_PATTERN, loadHub, WORK_ROLES, type AddArgs } from "../runs/node.ts";
import { dispatchNodeJob, nodeOutDir, profileRequire } from "./dispatch.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";

export const PLAN_USAGE = 'dispatch.sh plan <run-id> "<goal>|@file" [--profile P] [--node ID]';
export const PLAN_APPLY_USAGE = "dispatch.sh plan apply <run-id> [--file plan.json]";
const PLAN_NODE_DEFAULT = "plan";
const MAX_NODES_DEFAULT = 12;
const PLAN_LABEL_MAX = 80;
const ID_TEXT = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

const promptFile = (home: string, run: string, node: string) => join(home, "runs", run, "prompts", `${node}.md`);

function profileMenu(doc: any): string {
  const disabled: string[] = doc.settings?.disabled_harnesses ?? [];
  const dflt = doc.settings?.default_profile;
  const lines: string[] = [];
  for (const [name, p] of Object.entries<any>(doc.profiles ?? {})) {
    if (p.enabled === false || disabled.includes(p.harness)) continue;
    let l = `- ${name}${name === dflt ? " (default)" : ""}: harness ${p.harness}, model ${p.model ?? "-"}`;
    if ((p.description ?? "") !== "") l += `. ${p.description}`;
    if ((p.strengths ?? []).length > 0) l += ` Strengths: ${p.strengths.join(", ")}.`;
    if ((p.avoid_for ?? []).length > 0) l += ` Avoid for: ${p.avoid_for.join(", ")}.`;
    lines.push(l);
  }
  return lines.join("\n");
}

function planPromptText(runId: string, goal: string, outDir: string, maxNodes: number, maxParallel: number, dflt: string, menu: string): string {
  return `You are the planner for orch run ${runId}. Do not implement anything and do not edit project files.
Your only job is to read what you need, then write a plan that other coding agents will execute.

## Goal

${goal}

## Working directory

${process.cwd()}

## What to decide

1. Which tasks the goal needs, and how many agents that takes. Use as few as do the job well.
2. Which tasks are independent and can run in parallel, and which must wait for others.
3. Which profile runs each task. Default to "${dflt}" unless a task clearly needs another.

## Rules

- At most ${maxNodes} tasks. At most ${maxParallel} run at the same time, so keep each parallel stage at or under ${maxParallel} tasks.
- Run tasks in parallel only when they touch different files or areas. Tasks that edit the same files must be sequential ("after").
- When the plan branches, end with one integration task that depends on every branch and verifies the whole result (build, tests).
- Each task prompt must be self-contained: goal, files to touch, acceptance criteria, and the command that proves it works. The worker sees only its prompt plus the handoffs of the tasks it depends on.
- Task ids match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and must not be "${PLAN_NODE_DEFAULT}". "after" lists ids from this plan only.

## Profiles you can assign

${menu}

## Output

Write this JSON to ${outDir}/plan.json (the same path is in $ORCH_NODE_OUT):

{"summary": "one line", "tasks": [{"id": "api", "label": "short label", "profile": "${dflt}", "role": "implementation", "after": [], "prompt": "full instructions"}]}

"role" is one of: ${WORK_ROLES.join(" ")}. Use investigation for read-only research, implementation for code changes, validation for review and test or integration tasks. llm-hub picks the model for each task from its role.

Also write a readable version to ${outDir}/plan.md: the stages, what runs in parallel, why the split, and the risks.
Finish by replying with the summary line only.
`;
}

export async function planCommand(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  const rawGoal = args[1] ?? "";
  if (!runArg || !rawGoal) return (errLine(`usage: ${PLAN_USAGE}\n       ${PLAN_APPLY_USAGE}`), 2);
  let profile = "";
  let nodeId = PLAN_NODE_DEFAULT;
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--profile") profile = rest[++i] ?? "";
    else if (rest[i] === "--node") nodeId = rest[++i] ?? "";
    else return (errLine(`plan: unknown argument ${rest[i]}\n  usage: ${PLAN_USAGE}`), 2);
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (!ID_PATTERN.test(nodeId)) return (errLine(`plan: node id must match ${ID_TEXT}`), 2);
  const doc = await loadProfilesDoc(home);
  if (!profile) profile = settingFrom(doc, "planner_profile", "");
  if (!profile) return (errLine("plan: no planner — set settings.planner_profile or pass --profile"), 2);
  if (!(await profileRequire(home, profile))) return 2;
  let goal = rawGoal;
  if (rawGoal.startsWith("@")) {
    const f = Bun.file(rawGoal.slice(1));
    if (!(await f.exists())) return (errLine(`resolve_prompt: prompt file not found: ${rawGoal.slice(1)}`), 1);
    goal = await f.text();
  }
  if (!findNode(run, nodeId)) {
    const hub = await loadHub(home);
    const a: AddArgs = { id: nodeId, label: "Plan", after: "", profile, role: hub.on ? "planning" : "", tier: "", model: "", planBacked: false, acceptance: "" };
    const rc = await mutateRun(home, runId, (r, ctx) => applyAdd(r, a, ctx));
    if (rc !== 0) return rc;
  }
  const outDir = await nodeOutDir(home, runId, nodeId);
  const pf = promptFile(home, runId, nodeId);
  await mkdir(outDir, { recursive: true });
  await mkdir(dirname(pf), { recursive: true });
  await Bun.write(pf, planPromptText(runId, goal, outDir, settingUintFrom(doc, "max_nodes", MAX_NODES_DEFAULT), maxParallelCapFrom(doc), settingFrom(doc, "default_profile", ""), profileMenu(doc)));
  const rc = await mutateRun(home, runId, (r) => {
    r.plan = { node: nodeId, profile, applied: null, summary: null, tasks: 0 };
  });
  if (rc !== 0) return 1;
  const res = await dispatchNodeJob(home, runId, nodeId, ["--profile", profile, `@${pf}`]);
  if (res.rc === 0) process.stdout.write(res.jobId + "\n");
  return res.rc;
}

interface Task {
  id: string;
  label: string;
  profile: string;
  prompt: string;
  after: string[];
  layer: number;
  _i: number;
}

// PLAN_VALIDATE_JQ: errors, or tasks in dependency order plus warnings. A task naming an unusable profile
// falls back to the default profile with a warning.
export function validatePlan(plan: any, doc: any, existing: string[], max: number, planNode: string, dflt: string): { errors: string[] } | { summary: string; warnings: string[]; tasks: Task[] } {
  const t = plan.tasks;
  if (!Array.isArray(t) || t.length === 0) return { errors: ["plan.tasks must be a non-empty array"] };
  const idok = (x: any) => typeof x === "string" && ID_PATTERN.test(x);
  const ids = t.map((x: any) => x?.id);
  const errs: string[] = [];
  if (t.length > max) errs.push(`plan has ${t.length} tasks; settings.max_nodes is ${max}`);
  for (const x of t) if (!idok(x?.id)) errs.push(`task id ${JSON.stringify(x?.id ?? null)} must match ${ID_TEXT}`);
  const counts = new Map<string, number>();
  for (const i of ids.filter((i: any) => typeof i === "string")) counts.set(i, (counts.get(i) ?? 0) + 1);
  for (const i of [...counts.keys()].sort()) if (counts.get(i)! > 1) errs.push(`duplicate task id ${i}`);
  for (const x of t) if (x?.id === planNode || existing.includes(x?.id)) errs.push(`task id ${x.id} collides with an existing node`);
  for (const x of t) if (typeof x?.prompt !== "string" || x.prompt.length === 0) errs.push(`task ${x?.id} has no prompt`);
  for (const x of t) if (x && "after" in x && !Array.isArray(x.after)) errs.push(`task ${x.id}: after must be an array`);
  for (const x of t) if (Array.isArray(x?.after)) for (const d of x.after) if (!ids.includes(d)) errs.push(`task ${x.id} depends on unknown task ${d}`);
  if (errs.length > 0) return { errors: errs };
  const layer: Record<string, number> = {};
  for (let k = 0; k <= t.length; k++) {
    const L = { ...layer };
    for (const x of t) {
      if (x.id in L) continue;
      const ds = (x.after ?? []).map((d: string) => L[d]);
      if (ds.every((d: any) => d !== undefined)) layer[x.id] = (ds.length ? Math.max(...ds) : -1) + 1;
    }
  }
  const cyclic = t.filter((x: any) => layer[x.id] === undefined).map((x: any) => x.id);
  if (cyclic.length > 0) return { errors: [`dependency cycle among: ${cyclic.join(", ")}`] };
  const disabled: string[] = doc.settings?.disabled_harnesses ?? [];
  const warnings: string[] = [];
  const tasks: Task[] = t.map((x: any, i: number) => {
    const p = x.profile ?? "";
    const pp = p === "" ? null : doc.profiles?.[p] ?? null;
    let profile = p;
    if (p === "") profile = dflt;
    else if (pp === null) {
      profile = dflt;
      warnings.push(`task ${x.id}: unknown profile ${p}, using ${dflt}`);
    } else if (pp.enabled === false || disabled.includes(pp.harness)) {
      profile = dflt;
      warnings.push(`task ${x.id}: profile ${p} is disabled, using ${dflt}`);
    }
    return { id: x.id, layer: layer[x.id], _i: i, profile, prompt: x.prompt, label: String(x.label ?? x.id).slice(0, PLAN_LABEL_MAX), after: x.after ?? [] };
  });
  tasks.sort((a, b) => a.layer - b.layer || a._i - b._i);
  return { summary: plan.summary ?? "", warnings, tasks };
}

function taskFooter(runId: string, taskId: string, inputs: string, parallel: string): string {
  return `
---
orch context — run ${runId}, task ${taskId}.
Before you start, read the handoff files in: ${inputs}
When you finish, write your handoff (what you did, what changed, anything the next task must know or read) to $ORCH_NODE_OUT/handoff.md.
Running in parallel with you: ${parallel || "none"}. Stay inside your own task's files.
Talk to the coordinator or another task through the run mailbox:
  bash "$ORCH_DISPATCH" msg send ${runId} --to orch "<text>"          # blockers, questions, scope changes
  bash "$ORCH_DISPATCH" msg send ${runId} --to <task-id>|all "<text>" # a heads-up another task needs
  bash "$ORCH_DISPATCH" msg read ${runId}                            # messages for you
Read your messages before you start and again before you finish.
`;
}

export async function planApply(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  if (!runArg) return (errLine(`usage: ${PLAN_APPLY_USAGE}`), 2);
  let planFile = "";
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") planFile = rest[++i] ?? "";
    else return (errLine(`plan apply: unknown argument ${rest[i]}\n  usage: ${PLAN_APPLY_USAGE}`), 2);
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  const planNode = String(run.plan?.node ?? PLAN_NODE_DEFAULT);
  if (run.plan?.applied) return (errLine(`plan apply: run ${runId} already has an applied plan`), 2);
  if (!planFile) planFile = join(await nodeOutDir(home, runId, planNode, run), "plan.json");
  const f = Bun.file(planFile);
  if (!(await f.exists())) return (errLine(`plan apply: no plan at ${planFile}`), 1);
  let plan: any;
  try {
    plan = JSON.parse(await f.text());
  } catch {
    plan = null;
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return (errLine(`plan apply: ${planFile} is not a JSON object`), 1);
  const doc = await loadProfilesDoc(home);
  const dflt = settingFrom(doc, "default_profile", "");
  const checked = validatePlan(plan, doc, run.nodes.map((n) => n.id), settingUintFrom(doc, "max_nodes", MAX_NODES_DEFAULT), planNode, dflt);
  if ("errors" in checked) {
    for (const e of checked.errors) errLine(`plan apply: ${e}`);
    return 2;
  }
  for (const w of checked.warnings) errLine(`plan apply: warning: ${w}`);
  const hasPlanNode = !!findNode(run, planNode);
  const hub = await loadHub(home);
  let count = 0;
  for (const task of checked.tasks) {
    let role = "";
    if (!role && hub.on) role = "implementation";
    const deps = task.after.length > 0 ? task.after.join(",") : hasPlanNode ? planNode : "";
    const a: AddArgs = { id: task.id, label: task.label, after: deps, profile: task.profile, role, tier: "", model: "", planBacked: false, acceptance: "" };
    const rc = await mutateRun(home, runId, (r, ctx) => applyAdd(r, a, ctx));
    if (rc !== 0) return rc;
    const cur = await loadRun(home, runId);
    const inputs = deps ? await Promise.all(deps.split(",").map((d) => nodeOutDir(home, runId, d, cur))) : [];
    const parallel = checked.tasks.filter((x) => x.layer === task.layer && x.id !== task.id).map((x) => x.id).join(", ");
    const pf = promptFile(home, runId, task.id);
    await mkdir(dirname(pf), { recursive: true });
    await Bun.write(pf, task.prompt + "\n" + taskFooter(runId, task.id, inputs.join(", ") || "none", parallel));
    count++;
  }
  const rc = await mutateRun(home, runId, (r) => {
    r.plan = { ...(r.plan ?? { node: planNode }), applied: nowIso(), summary: checked.summary, tasks: count };
  });
  if (rc !== 0) return 1;
  const stages: Task[][] = [];
  for (const t of checked.tasks) (stages[t.layer] ??= []).push(t);
  process.stdout.write(`applied: ${count} task(s)\n`);
  process.stdout.write(`stages: ${stages.filter(Boolean).map((g) => g.map((x) => x.id).join("+")).join(" -> ")}\n`);
  return 0;
}
