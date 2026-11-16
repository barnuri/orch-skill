// `node usage | cost | out | digest | remove | ping`. Ported from lib/runs/runs.sh and lib/runs/visibility.sh.
import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { jobStatus } from "../state/proc.ts";
import { ev, findNode, ID_PATTERN, OpError } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import { nodeOutDir } from "./dispatch.ts";

const USAGE_CATEGORIES = ["tool", "mcp", "skill", "subagent", "agent"];
const USAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const USAGE_COUNT_MAX = 1000000;
const DIGEST_LINES_DEFAULT = 10;
const DIGEST_LINES_MAX = 200;
const NODE_NOTES_KEEP = 20;
const ID_TEXT = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

const NODE_USAGE_USAGE = "dispatch.sh node usage <run-id> <node-id> [--add c.name=N]... [--set c.name=N]... [--clear]";
const NODE_COST_USAGE = "dispatch.sh node cost <run-id> <node-id> (--from-job <job-id> | --clear)";
const NODE_OUT_USAGE = "dispatch.sh node out <run-id> <node-id>";
const NODE_DIGEST_USAGE = "dispatch.sh node digest <run-id> <node-id> [--lines N]";
const NODE_PING_USAGE = 'dispatch.sh node ping <run-id> <node-id> [--note "text"] [--progress "3/10"]';
const NODE_REMOVE_USAGE = "dispatch.sh node remove <run-id> <node-id> [--force]";

const alt = (v: any, d: any) => (v === null || v === undefined || v === false ? d : v);
const out = (s: string) => void process.stdout.write(s);
const isUint = (s: string) => /^[0-9]+$/.test(s);

// Resolves run and node: prints the problem and returns null (code 2 as bash).
async function target(cmd: string, args: string[], usage: string): Promise<{ home: string; runId: string; nodeId: string } | { rc: number }> {
  const [runArg = "", nodeId = ""] = args;
  if (!runArg || !nodeId) return (errLine(`usage: ${usage}`), { rc: 2 });
  return { home: orchHome(), runId: runArg, nodeId };
}

async function checked(cmd: string, t: { home: string; runId: string; nodeId: string }): Promise<number> {
  const runId = await resolveRun(t.home, t.runId);
  if (runId === null) return 1;
  t.runId = runId;
  const run = await loadRun(t.home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (!findNode(run, t.nodeId)) return (errLine(`node ${t.nodeId}: not in this run`), 2);
  return 0;
}

// ---- usage -------------------------------------------------------------------------------------------

interface UsageOp {
  op: string;
  cat: string;
  name: string;
  count: number;
}

function parseTerm(flag: string, term: string): UsageOp | string {
  const bad = `node usage: ${flag} expects <category>.<name>=<count>, got ${term}`;
  const eq = term.indexOf("=");
  if (eq < 0) return bad;
  const path = term.slice(0, eq);
  const count = term.slice(eq + 1);
  const dot = path.indexOf(".");
  const cat = dot < 0 ? path : path.slice(0, dot);
  const name = dot < 0 ? path : path.slice(dot + 1);
  if (!name || name === cat) return bad;
  if (!USAGE_CATEGORIES.includes(cat)) return `node usage: category must be one of: ${USAGE_CATEGORIES.join(" ")}`;
  if (!USAGE_NAME_PATTERN.test(name)) return `node usage: name must match ${USAGE_NAME_PATTERN.source.replace(/\\/g, "")}`;
  if (!isUint(count) || Number(count) > USAGE_COUNT_MAX) return `node usage: count must be an integer in 0..${USAGE_COUNT_MAX}, got ${count}`;
  return { op: "", cat, name, count: Number(count) };
}

export async function nodeUsage(args: string[]): Promise<number> {
  const t = await target("usage", args, NODE_USAGE_USAGE);
  if ("rc" in t) return t.rc;
  let clear = false;
  const ops: UsageOp[] = [];
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--clear") clear = true;
    else if (a === "--add" || a === "--set") {
      const op = a.slice(2);
      if (i + 1 >= rest.length) return (errLine(`node usage: --${op} expects a value`), 2);
      const r = parseTerm(`--${op}`, rest[++i]);
      if (typeof r === "string") return (errLine(r), 2);
      ops.push({ ...r, op });
    } else return (errLine(`node usage: unknown argument ${a}`), 2);
  }
  const rc0 = await checked("usage", t);
  if (rc0 !== 0) return rc0;
  if (!clear && ops.length === 0) return (errLine(`node usage: nothing to do — pass --add, --set or --clear\n  usage: ${NODE_USAGE_USAGE}`), 2);
  const rc = await mutateRun(t.home, t.runId, (r, ctx) => {
    const n = findNode(r, t.nodeId)!;
    n.updated = ctx.now;
    n.usage = clear ? {} : (n.usage ?? {});
    for (const o of ops) {
      const cur = n.usage[o.cat]?.[o.name] ?? 0;
      const next = o.op === "add" ? cur + o.count : o.count;
      if (next <= 0) {
        if (n.usage[o.cat] && o.name in n.usage[o.cat]) delete n.usage[o.cat][o.name];
      } else n.usage[o.cat] = { ...(n.usage[o.cat] ?? {}), [o.name]: next };
      if (n.usage[o.cat] && Object.keys(n.usage[o.cat]).length === 0) delete n.usage[o.cat];
    }
  });
  if (rc !== 0) return 1;
  const run = (await loadRun(t.home, t.runId))!;
  out(JSON.stringify(findNode(run, t.nodeId)!.usage ?? {}) + "\n");
  return 0;
}

// ---- cost --------------------------------------------------------------------------------------------

export async function nodeCost(args: string[]): Promise<number> {
  const t = await target("cost", args, NODE_COST_USAGE);
  if ("rc" in t) return t.rc;
  let jobId = "";
  let clear = false;
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--from-job") {
      jobId = rest[++i] ?? "";
      if (!jobId) return (errLine(`node cost: --from-job expects a job id\n  usage: ${NODE_COST_USAGE}`), 2);
    } else if (rest[i] === "--clear") clear = true;
    else return (errLine(`node cost: unknown argument ${rest[i]}\n  usage: ${NODE_COST_USAGE}`), 2);
  }
  const rc0 = await checked("cost", t);
  if (rc0 !== 0) return rc0;
  if (clear && jobId) return (errLine(`node cost: pass either --from-job or --clear, not both\n  usage: ${NODE_COST_USAGE}`), 2);
  if (clear) return mutateRun(t.home, t.runId, (r) => void (findNode(r, t.nodeId)!.cost = null));
  if (!jobId) return (errLine(`node cost: nothing to do — pass --from-job or --clear\n  usage: ${NODE_COST_USAGE}`), 2);
  const file = join(paths.jobs(t.home), jobId, "usage.json");
  if (!existsSync(file)) return (errLine(`node cost: job ${jobId} recorded no usage`), 1);
  let cost: any;
  try {
    cost = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return 0;
  }
  if (!cost || typeof cost !== "object" || Array.isArray(cost) || !("usd" in cost)) return 0;
  return mutateRun(t.home, t.runId, (r) => void (findNode(r, t.nodeId)!.cost = cost));
}

// ---- out ---------------------------------------------------------------------------------------------

export async function nodeOut(args: string[]): Promise<number> {
  const t = await target("out", args, NODE_OUT_USAGE);
  if ("rc" in t) return t.rc;
  if (args.length > 2) return (errLine(`usage: ${NODE_OUT_USAGE}`), 2);
  const runId = await resolveRun(t.home, t.runId);
  if (runId === null) return 1;
  const run = await loadRun(t.home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (!ID_PATTERN.test(t.nodeId)) return (errLine(`node out: id must match ${ID_TEXT}`), 2);
  if (!findNode(run, t.nodeId)) return (errLine(`node ${t.nodeId}: not in this run`), 2);
  const dir = await nodeOutDir(t.home, runId, t.nodeId, run);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return (errLine(`node out: cannot create ${dir}`), 1);
  }
  out(dir + "\n");
  return 0;
}

// ---- digest ------------------------------------------------------------------------------------------

export async function nodeDigest(args: string[]): Promise<number> {
  const t = await target("digest", args, NODE_DIGEST_USAGE);
  if ("rc" in t) return t.rc;
  let lines = DIGEST_LINES_DEFAULT;
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--lines") {
      const v = rest[++i] ?? "";
      if (!isUint(v) || Number(v) < 1 || Number(v) > DIGEST_LINES_MAX) return (errLine(`node digest: --lines expects 1..${DIGEST_LINES_MAX}`), 2);
      lines = Number(v);
    } else return (errLine(`node digest: unknown argument ${rest[i]}\n  usage: ${NODE_DIGEST_USAGE}`), 2);
  }
  const runId = await resolveRun(t.home, t.runId);
  if (runId === null) return 1;
  const run = await loadRun(t.home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (!ID_PATTERN.test(t.nodeId)) return (errLine(`node digest: id must match ${ID_TEXT}`), 2);
  const n = findNode(run, t.nodeId);
  if (!n) return (errLine(`node ${t.nodeId}: not in this run`), 2);
  const job = String(n.job_id ?? "");
  let s = `node: ${t.nodeId} (${n.status})\nout: ${await nodeOutDir(t.home, runId, t.nodeId, run)}\n`;
  if (n.report != null) {
    const p = n.report;
    s += `reported: ${p.reported_by} model=${alt(p.model, "-")} in=${alt(p.input_tokens, "-")} out=${alt(p.output_tokens, "-")} usd=${alt(p.usd, "-")}\n`;
  }
  if (!job) return (out(s + "log: not dispatched\n"), 0);
  const st = jobStatus(paths.jobs(t.home), job) ?? "unknown";
  s += `job: ${job}\nexit: ${st.replace(/^done exit=/, "")}\n`;
  const dir = join(paths.jobs(t.home), job);
  const log = existsSync(join(dir, "log.plain")) ? join(dir, "log.plain") : join(dir, "log");
  if (!existsSync(log)) return (out(s + "log: none on disk\n"), 0);
  const buf = readFileSync(log);
  const text = buf.toString("utf8");
  const arr = text.split("\n");
  const total = arr.length - 1;
  s += `log: ${buf.length} bytes, ${total} lines\n`;
  if (total <= lines * 2) return (out(s + text), 0);
  const body = text.endsWith("\n") ? arr.slice(0, -1) : arr;
  s += `--- first ${lines} ---\n${body.slice(0, lines).join("\n")}\n`;
  s += `--- ${total - lines * 2} lines elided ---\n--- last ${lines} ---\n${body.slice(-lines).join("\n")}\n`;
  out(s);
  return 0;
}

// ---- remove ------------------------------------------------------------------------------------------

export async function nodeRemove(args: string[]): Promise<number> {
  const t = await target("remove", args, NODE_REMOVE_USAGE);
  if ("rc" in t) return t.rc;
  let force = false;
  for (const a of args.slice(2)) {
    if (a === "--force") force = true;
    else return (errLine(`node remove: unknown argument ${a}`), 2);
  }
  const rc0 = await checked("remove", t);
  if (rc0 !== 0) return rc0;
  return mutateRun(t.home, t.runId, (r, ctx) => {
    const n = findNode(r, t.nodeId)!;
    const status = String(n.status);
    const blockers = (r.edges ?? [])
      .filter((e: string[]) => e[0] === t.nodeId)
      .flatMap((e: string[]) => r.nodes.filter((x) => x.id === e[1] && (x.status === "running" || x.status === "done")).map((x) => x.id));
    if (!force) {
      if (status !== "waiting") throw new OpError(`node remove: ${t.nodeId} is ${status}; only a waiting node can be removed (--force overrides)`);
      if (blockers.length) throw new OpError(`node remove: ${t.nodeId} has running or done dependents: ${blockers.join(",")} (--force overrides)`);
    }
    r.nodes = r.nodes.filter((x) => x.id !== t.nodeId);
    r.edges = (r.edges ?? []).filter((e: string[]) => e[0] !== t.nodeId && e[1] !== t.nodeId);
    ev(ctx, "remove", t.nodeId, status, "", "");
  });
}

// ---- ping --------------------------------------------------------------------------------------------

export async function nodePing(args: string[]): Promise<number> {
  const t = await target("ping", args, NODE_PING_USAGE);
  if ("rc" in t) return t.rc;
  let note = "";
  let progress = "";
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--note") note = rest[++i] ?? "";
    else if (rest[i] === "--progress") progress = rest[++i] ?? "";
    else return (errLine(`node ping: unknown argument ${rest[i]}\n  usage: ${NODE_PING_USAGE}`), 2);
  }
  const rc0 = await checked("ping", t);
  if (rc0 !== 0) return rc0;
  return mutateRun(t.home, t.runId, (r, ctx) => {
    const n = findNode(r, t.nodeId)!;
    n.updated = ctx.now;
    if (note) n.notes = [...(n.notes ?? []), { at: ctx.now, text: note }].slice(-NODE_NOTES_KEEP);
    if (progress) n.progress = progress;
    if (n.status === "running" && n.seg_open && n.started_at == null) {
      n.started_at = n.dispatched_at != null && ctx.now < n.dispatched_at ? n.dispatched_at : ctx.now;
      ev(ctx, "started", t.nodeId, "starting", "running", "ping");
    }
    if (note) ev(ctx, "note", t.nodeId, "", "", note);
    else ev(ctx, "ping", t.nodeId, "", "", progress);
  });
}
