// Requirements ledger: <run>/requirements.json. `req add|link|evidence|status|list|check`. Single writer: this file,
// under the lock `req-<run>`. `run verify` (commands/verify.ts) reuses reqProblems.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { loadRun, readJson, writeJsonAtomic, type RunState } from "../state/store.ts";
import { acquireLock } from "../state/lock.ts";
import { resolveRun, errLine } from "./node.ts";
import { handoffProblem } from "../runs/node.ts";

export const REQ_STATUSES = ["handled", "partly", "not", "superseded", "waived"];
export const REQ_OK = ["handled", "superseded", "waived"];
export const REQ_USAGE = {
  add: 'dispatch.ts req add <run-id> "<user ask>" [--id R1] [--node n1,n2]',
  link: "dispatch.ts req link <run-id> <req-id> --node n",
  evidence: 'dispatch.ts req evidence <run-id> <req-id> --note "<text>" [--file path] [--test "bun test ..."]',
  status: `dispatch.ts req status <run-id> <req-id> ${REQ_STATUSES.join("|")} [--reason T]`,
  list: "dispatch.ts req list <run-id> [--json]",
  check: "dispatch.ts req check <run-id>",
};

export interface Req {
  id: string;
  text: string;
  status: string;
  reason: string | null;
  nodes: string[];
  evidence: Array<{ note: string; file: string | null; test: string | null; at: string }>;
  created: string;
  updated: string;
}
export interface Ledger { requirements: Req[] }

const out = (s: string) => void process.stdout.write(s);
export const reqFile = (home: string, runId: string) => join(paths.runs(home), runId, "requirements.json");

export async function loadLedger(home: string, runId: string): Promise<Ledger> {
  const f = reqFile(home, runId);
  if (!existsSync(f)) return { requirements: [] };
  try {
    const l = await readJson<Ledger>(f);
    return { requirements: Array.isArray(l.requirements) ? l.requirements : [] };
  } catch {
    return { requirements: [] };
  }
}

class ReqError extends Error {}

async function mutateLedger(home: string, runId: string, fn: (l: Ledger, run: RunState, now: string) => string): Promise<number> {
  // 400 tries x 50 ms: a writer that holds the lock longer than 20 s makes this exit 75. A dead holder is reclaimed at once (pid check).
  const lock = await acquireLock(home, `req-${runId}`, 400, 50);
  if (!lock) return (errLine(`run ${runId}: requirements are locked by another writer`), 75);
  try {
    const run = await loadRun(home, runId);
    if (!run) return (errLine(`run ${runId}: unknown run`), 2);
    const l = await loadLedger(home, runId);
    let msg: string;
    try {
      msg = fn(l, run, nowIso());
    } catch (e) {
      if (!(e instanceof ReqError)) throw e;
      errLine(e.message);
      return 2;
    }
    await writeJsonAtomic(reqFile(home, runId), l);
    if (msg) out(msg + "\n");
    return 0;
  } finally {
    await lock.release();
  }
}

const fail = (m: string): never => { throw new ReqError(m); };

// Splits flags from positionals; `flags` lists the flags that take a value.
function parse(args: string[], valued: string[], bools: string[] = []): { pos: string[]; f: Record<string, string>; b: Set<string> } {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  const b = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) fail(`${a} expects a value, not a flag`);
      f[a] = args[++i]!;
    } else if (bools.includes(a)) b.add(a);
    else if (a.startsWith("--")) fail(`unknown argument ${a}`);
    else pos.push(a);
  }
  return { pos, f, b };
}

const csv = (s: string) => s.split(/[,\s]+/).filter(Boolean);
const need = (l: Ledger, id: string): Req => l.requirements.find((r) => r.id === id) ?? fail(`req ${id}: not in this run`);
function needNodes(run: RunState, nodes: string[]): void {
  for (const n of nodes) if (!run.nodes.some((x) => x.id === n)) fail(`node ${n}: not in this run`);
}

async function prep(args: string[], usage: string, valued: string[], bools: string[] = []) {
  const home = orchHome();
  let p;
  try {
    p = parse(args, valued, bools);
  } catch (e) {
    errLine(`${(e as Error).message}\n  usage: ${usage}`);
    return null;
  }
  const runId = p.pos[0] ? await resolveRun(home, p.pos[0]) : null;
  if (!runId) {
    if (!p.pos[0]) errLine(`usage: ${usage}`);
    return null;
  }
  return { home, runId, p };
}

export async function reqAdd(args: string[]): Promise<number> {
  const c = await prep(args, REQ_USAGE.add, ["--id", "--node"]);
  if (!c) return 2;
  const text = c.p.pos[1];
  if (!text || c.p.pos.length > 2) return (errLine(`usage: ${REQ_USAGE.add}`), 2);
  return mutateLedger(c.home, c.runId, (l, run, now) => {
    const id = c.p.f["--id"] || `R${1 + Math.max(0, ...l.requirements.map((r) => Number(/^R(\d+)$/.exec(r.id)?.[1] ?? 0)))}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail("req add: id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$");
    if (l.requirements.some((r) => r.id === id)) fail(`req add: ${id} already exists`);
    const nodes = csv(c.p.f["--node"] ?? "");
    needNodes(run, nodes);
    l.requirements.push({ id, text, status: "not", reason: null, nodes, evidence: [], created: now, updated: now });
    return id;
  });
}

export async function reqLink(args: string[]): Promise<number> {
  const c = await prep(args, REQ_USAGE.link, ["--node"]);
  if (!c) return 2;
  const id = c.p.pos[1];
  const nodes = csv(c.p.f["--node"] ?? "");
  if (!id || c.p.pos.length > 2 || nodes.length === 0) return (errLine(`usage: ${REQ_USAGE.link}`), 2);
  return mutateLedger(c.home, c.runId, (l, run, now) => {
    const r = need(l, id);
    needNodes(run, nodes);
    r.nodes = [...new Set([...r.nodes, ...nodes])];
    r.updated = now;
    return `${id} linked ${nodes.join(",")}`;
  });
}

export async function reqEvidence(args: string[]): Promise<number> {
  const c = await prep(args, REQ_USAGE.evidence, ["--note", "--file", "--test"]);
  if (!c) return 2;
  const id = c.p.pos[1];
  const { "--note": note, "--file": file, "--test": test } = c.p.f;
  if (!id || c.p.pos.length > 2 || !note) return (errLine(`usage: ${REQ_USAGE.evidence}`), 2);
  return mutateLedger(c.home, c.runId, (l, _run, now) => {
    const r = need(l, id);
    r.evidence.push({ note, file: file ?? null, test: test ?? null, at: now });
    r.updated = now;
    return `${id} evidence ${r.evidence.length}`;
  });
}

export async function reqStatus(args: string[]): Promise<number> {
  const c = await prep(args, REQ_USAGE.status, ["--reason"]);
  if (!c) return 2;
  const [, id, status] = c.p.pos;
  if (!id || !status || c.p.pos.length > 3) return (errLine(`usage: ${REQ_USAGE.status}`), 2);
  if (!REQ_STATUSES.includes(status)) return (errLine(`req status: status must be one of: ${REQ_STATUSES.join(" ")}`), 2);
  return mutateLedger(c.home, c.runId, (l, _run, now) => {
    const r = need(l, id);
    if (status === "waived" && !c.p.f["--reason"]) fail("req status: waived needs --reason");
    r.status = status;
    r.reason = c.p.f["--reason"] ?? r.reason;
    r.updated = now;
    return `${id} ${status}`;
  });
}

export async function reqList(args: string[]): Promise<number> {
  const c = await prep(args, REQ_USAGE.list, [], ["--json"]);
  if (!c) return 2;
  const l = await loadLedger(c.home, c.runId);
  if (c.p.b.has("--json")) return (out(JSON.stringify(l, null, 2) + "\n"), 0);
  for (const r of l.requirements) out(`${r.id}\t${r.status}\t${r.nodes.join(",") || "-"}\t${r.text}\n`);
  return 0;
}

// ---- check -------------------------------------------------------------------------------------------

export interface NodeFacts { id: string; status: string; done: boolean; handoff: boolean; unverified: boolean; missing: boolean }

export function handoffProblemOf(home: string, runId: string, n: Record<string, any>) {
  const recorded = typeof n.out_dir === "string" && n.out_dir !== "" ? n.out_dir : "";
  return handoffProblem(join(recorded || paths.runOutDir(home, runId, n.id), "handoff.md"), n);
}

// True when the handoff has non-whitespace content and is not older than the node's latest attempt.
export const handoffNonEmpty = (home: string, runId: string, n: Record<string, any>): boolean => handoffProblemOf(home, runId, n) === "";

export function nodeFacts(home: string, runId: string, run: RunState, id: string): NodeFacts {
  const n = run.nodes.find((x) => x.id === id);
  if (!n) return { id, status: "missing", done: false, handoff: false, unverified: false, missing: true };
  return { id, status: n.status, done: n.status === "done", handoff: handoffNonEmpty(home, runId, n), unverified: n.unverified === true, missing: false };
}

export interface ReqView { req: Req; ok: boolean; nodes: NodeFacts[] }

export function reqViews(home: string, runId: string, run: RunState, l: Ledger): ReqView[] {
  return l.requirements.map((req) => ({ req, ok: REQ_OK.includes(req.status), nodes: req.nodes.map((id) => nodeFacts(home, runId, run, id)) }));
}

export async function reqCheck(args: string[]): Promise<number> {
  const c = await prep(args, REQ_USAGE.check, []);
  if (!c) return 2;
  if (c.p.pos.length > 1) return (errLine(`usage: ${REQ_USAGE.check}`), 2);
  const run = (await loadRun(c.home, c.runId))!;
  const views = reqViews(c.home, c.runId, run, await loadLedger(c.home, c.runId));
  if (views.length === 0) out("no requirements recorded\n");
  for (const v of views) {
    out(`${v.req.id} [${v.req.status}] ${v.ok ? "ok" : "OPEN"} ${v.req.text}${v.req.reason ? ` (${v.req.reason})` : ""}\n`);
    for (const n of v.nodes) {
      out(`  ${n.id}: ${n.missing ? "missing" : n.status} done=${n.done} handoff=${n.handoff ? "yes" : "no"} unverified=${n.unverified}\n`);
    }
  }
  const open = views.filter((v) => !v.ok);
  out(open.length ? `FAIL: ${open.length} of ${views.length} requirement(s) not handled\n` : `ok: ${views.length} requirement(s) closed\n`);
  return open.length ? 1 : 0;
}

// For `run verify`: one problem string per open requirement.
export async function reqProblems(home: string, runId: string, run: RunState): Promise<Array<{ nodes: string[]; msg: string; hint: string }>> {
  return reqViews(home, runId, run, await loadLedger(home, runId))
    .filter((v) => !v.ok)
    .map((v) => ({
      nodes: v.req.nodes,
      msg: `requirement ${v.req.id} is ${v.req.status}: ${v.req.text}`,
      hint: `finish the work, then: dispatch.ts req evidence ${runId} ${v.req.id} --note "..." and dispatch.ts req status ${runId} ${v.req.id} handled (or superseded|waived --reason)`,
    }));
}
