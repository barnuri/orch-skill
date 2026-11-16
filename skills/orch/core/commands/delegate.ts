// `orch delegate <run> plan|task|finding|show ...`. Ported from lib/runs/delegate.sh.
// State lives in state.json under `.delegation`. Every write goes through mutateRun (run lock).
import { orchHome, paths } from "../state/home.ts";
import { loadRun, readJson } from "../state/store.ts";
import { OpError, ID_PATTERN } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";

export const DELEGATE_USAGE = `dispatch.ts delegate <run-id> plan "<text>|@file"
       dispatch.ts delegate <run-id> task add <id> --stage plan|implement|review|fix --profile P [--label L]
       dispatch.ts delegate <run-id> task set <id> todo|doing|done|blocked
       dispatch.ts delegate <run-id> finding add <task-id> "<text>"
       dispatch.ts delegate <run-id> finding close <F-id>
       dispatch.ts delegate <run-id> show [--json]`;
const STAGES = ["plan", "implement", "review", "fix"];
const TASK_STATUSES = ["todo", "doing", "done", "blocked"];
const PLAN_MAX = 20000;

function out(s: string): void {
  process.stdout.write(s);
}

function fail(msg: string): number {
  errLine(msg);
  return 2;
}

function usage(): number {
  return fail(`usage: ${DELEGATE_USAGE}`);
}

// Same as bash `$(cat file)`: trailing newlines are dropped.
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

// strong (quality high or best) or cheap. Null when the profile does not exist.
async function profileClass(home: string, name: string): Promise<"strong" | "cheap" | null> {
  const doc = await readJson<{ profiles?: Record<string, any> }>(paths.profiles(home)).catch(() => ({}));
  const p = doc.profiles?.[name];
  if (!p) return null;
  return p.quality === "high" || p.quality === "best" ? "strong" : "cheap";
}

// Resolves `.` to the saved run and checks it exists. Prints the problem and returns null.
async function requireRun(home: string, arg: string): Promise<string | null> {
  const runId = await resolveRun(home, arg);
  if (runId === null) return null;
  if (await loadRun(home, runId)) return runId;
  errLine(`run ${runId}: unknown run`);
  return null;
}

export async function delegatePlan(args: string[]): Promise<number> {
  const runId = args[0] ?? "";
  let text = args[1] ?? "";
  if (!text) return usage();
  if (text.startsWith("@")) {
    const file = text.slice(1);
    const f = Bun.file(file);
    if (!(await f.exists())) return fail(`delegate plan: no file ${file}`);
    text = stripTrailingNewlines(await f.text());
  }
  if ([...text].length > PLAN_MAX) return fail(`delegate plan: plan is over ${PLAN_MAX} characters`);
  const home = orchHome();
  const id = await requireRun(home, runId);
  if (id === null) return 2;
  const rc = await mutateRun(home, id, (run) => {
    run.delegation ??= { plan: null, tasks: [], findings: [] };
    run.delegation.plan = text;
  });
  if (rc === 0) out("plan stored\n");
  return rc;
}

export async function delegateTask(args: string[]): Promise<number> {
  const [arg = "", verb = "", id = ""] = args;
  const home = orchHome();
  const runId = await requireRun(home, arg);
  if (runId === null) return 2;
  if (verb === "add") {
    let stage = "";
    let profile = "";
    let label = "";
    const rest = args.slice(3);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--stage") stage = rest[++i] ?? "";
      else if (a === "--profile") profile = rest[++i] ?? "";
      else if (a === "--label") label = rest[++i] ?? "";
      else return fail(`delegate task: unknown argument ${a}`);
    }
    if (!ID_PATTERN.test(id)) return fail(`delegate task: bad id ${id}`);
    if (!STAGES.includes(stage)) return fail(`delegate task: stage must be one of: ${STAGES.join(" ")}`);
    const cls = await profileClass(home, profile);
    if (cls === null) return fail(`delegate task: unknown profile ${profile}`);
    const want = stage === "plan" || stage === "review" ? "strong" : "cheap";
    if (cls !== want) {
      return fail(`delegate task: stage ${stage} needs a ${want} profile (quality high or best for strong); ${profile} is ${cls}`);
    }
    const rc = await mutateRun(home, runId, (run) => {
      run.delegation ??= { plan: null, tasks: [], findings: [] };
      const tasks: any[] = run.delegation.tasks;
      if (tasks.some((t) => t.id === id)) throw new OpError(`delegate task: task ${id} already exists`);
      tasks.push({ id, label: label === "" ? id : label, stage, profile, status: "todo" });
    });
    if (rc === 0) out(`task ${id} added\n`);
    return rc;
  }
  if (verb === "set") {
    const status = args[3] ?? "";
    if (!TASK_STATUSES.includes(status)) {
      return fail(`delegate task: status must be one of: ${TASK_STATUSES.join(" ")}`);
    }
    const rc = await mutateRun(home, runId, (run) => {
      const t = (run.delegation?.tasks ?? []).find((x: any) => x.id === id);
      if (!t) throw new OpError(`delegate task: unknown task ${id}`);
      t.status = status;
    });
    if (rc === 0) out(`task ${id} ${status}\n`);
    return rc;
  }
  return usage();
}

export async function delegateFinding(args: string[]): Promise<number> {
  const [arg = "", verb = "", a = "", b = ""] = args;
  const home = orchHome();
  const runId = await requireRun(home, arg);
  if (runId === null) return 2;
  if (verb === "add") {
    let next = "";
    const rc = await mutateRun(home, runId, (run) => {
      run.delegation ??= { plan: null, tasks: [], findings: [] };
      if (!(run.delegation.tasks as any[]).some((t) => t.id === a)) {
        throw new OpError(`delegate finding: unknown task ${a}`);
      }
      if (b === "") throw new OpError("delegate finding: text is empty");
      next = `F${(run.delegation.findings ?? []).length + 1}`;
      run.delegation.findings = [...(run.delegation.findings ?? []), { id: next, task: a, text: b, status: "open" }];
    });
    if (rc === 0) out(`${next}\n`);
    return rc;
  }
  if (verb === "close") {
    const rc = await mutateRun(home, runId, (run) => {
      const f = (run.delegation?.findings ?? []).find((x: any) => x.id === a);
      if (!f) throw new OpError(`delegate finding: unknown finding ${a}`);
      f.status = "closed";
    });
    if (rc === 0) out(`finding ${a} closed\n`);
    return rc;
  }
  return usage();
}

export async function delegateShow(args: string[]): Promise<number> {
  const home = orchHome();
  const runId = await requireRun(home, args[0] ?? "");
  if (runId === null) return 2;
  const run = await loadRun(home, runId);
  if (!run) return 2;
  const d = run.delegation ?? { plan: null, tasks: [], findings: [] };
  if (args[1] === "--json") {
    out(JSON.stringify(d) + "\n");
    return 0;
  }
  const lines: string[] = ["plan:", d.plan ?? "(none)", "tasks:"];
  if (d.tasks.length === 0) lines.push("  (none)");
  for (const t of d.tasks) lines.push(`  ${t.id}\t${t.stage}\t${t.profile}\t${t.status}\t${t.label}`);
  const open = (d.findings as any[]).filter((f) => f.status === "open");
  lines.push(`open findings: ${open.length}`);
  for (const f of open) lines.push(`  ${f.id}\t${f.task}\t${f.text}`);
  out(lines.join("\n") + "\n");
  return 0;
}
