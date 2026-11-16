// `classify`, `budget-check`, `status`, `tail`, `wait`, `list`: the job-level commands and the router hint.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { jobStatus, sleep } from "../state/proc.ts";
import { budgetCheck, budgetVerdict, readCatalog } from "../adapters/routing.ts";

const out = (s: string) => void process.stdout.write(s);
const err = (s: string) => void process.stderr.write(s);
const onPath = (bin: string) => Bun.which(bin, { PATH: process.env.PATH ?? "" }) !== null;

export async function budgetCheckCommand(): Promise<number> {
  const cat = await readCatalog(paths.profiles(orchHome()));
  const { ok, reason } = await budgetVerdict(cat);
  err(`budget-check: ${ok ? "safe to route to Claude" : "avoid routing more to Claude"}: ${reason}\n`);
  return ok ? 0 : 1;
}

export async function classifyCommand(args: string[]): Promise<number> {
  let description = "";
  let complexity = "";
  let preferLocal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--complexity") complexity = args[++i] ?? "";
    else if (a === "--prefer-local") preferLocal = true;
    else if (!description) description = a;
  }
  if (!complexity) complexity = description.split(/\s+/).filter(Boolean).length <= 15 ? "small" : "medium";
  const budgetOk = await budgetCheck(await readCatalog(paths.profiles(orchHome())));
  const hub = !!process.env.LLM_HUB_URL;
  if ((complexity === "trivial" || complexity === "small") && budgetOk) return (out("claude-native\n"), 0);
  if (!budgetOk) {
    if (onPath("cursor-agent")) out("cursor-agent\n");
    else if (onPath("opencode")) out("opencode\n");
    else if (onPath("copilot")) out("copilot\n");
    else if (hub) out("local-llm\n");
    else {
      err("classify: no alternate harness available — routing to claude-native despite budget pressure\n");
      out("claude-native\n");
    }
    return 0;
  }
  if (preferLocal || (complexity === "medium" && hub)) return (out("local-llm\n"), 0);
  out("claude-native\n");
  return 0;
}

export function statusCommand(args: string[]): number {
  const id = args[0] ?? "";
  if (!id) return (err("usage: dispatch.ts status <job-id>\n"), 2);
  const st = jobStatus(paths.jobs(orchHome()), id);
  if (st === null) return (err(`unknown job: ${id}\n`), 2);
  out(st + "\n");
  return 0;
}

export function tailCommand(args: string[]): number {
  const id = args[0] ?? "";
  if (!id) return (err("usage: dispatch.ts tail <job-id> [-n N]\n"), 2);
  let n = 20;
  for (let i = 1; i < args.length; i++) if (args[i] === "-n") n = Number(args[++i] ?? 20) || 20;
  const dir = join(paths.jobs(orchHome()), id);
  const file = existsSync(join(dir, "log.plain")) ? join(dir, "log.plain") : join(dir, "log");
  if (!existsSync(file)) return (err(`no log for job: ${id}\n`), 2);
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-n).join("\n");
  if (tail) out(tail + "\n");
  return 0;
}

export async function waitCommand(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!id) return (err("usage: dispatch.ts wait <job-id> [--timeout SECS] [--interval SECS]\n"), 2);
  let timeout = 300;
  let interval = 5;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--timeout") timeout = Number(args[++i] ?? 300);
    else if (args[i] === "--interval") interval = Number(args[++i] ?? 5);
  }
  const jobs = paths.jobs(orchHome());
  const start = Date.now();
  let gap = 50;
  for (;;) {
    const st = jobStatus(jobs, id);
    if (st === null) return (err(`unknown job: ${id}\n`), 2);
    if (st.startsWith("done")) return (out(st + "\n"), 0);
    if ((Date.now() - start) / 1000 >= timeout) return (err(`wait: timed out after ${timeout}s (job still running)\n`), 124);
    await sleep(Math.min(gap, interval * 1000));
    gap = Math.min(gap * 2, 1000);
  }
}

export function listCommand(): number {
  const jobs = paths.jobs(orchHome());
  if (!existsSync(jobs)) return (out("no jobs\n"), 0);
  const rows = readdirSync(jobs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      let profile = "-";
      try { profile = readFileSync(join(jobs, d.name, "profile"), "utf8").trim(); } catch {}
      return `${d.name}\t${jobStatus(jobs, d.name)}\t${profile}`;
    })
    .sort()
    .reverse();
  if (rows.length) out(rows.join("\n") + "\n");
  return 0;
}
