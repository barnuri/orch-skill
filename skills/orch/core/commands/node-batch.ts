// `node batch`: many node add / report / update ops in one process and one state write.
// Port of lib/runs/batch.sh. Every op is checked in order against the in-memory run. When any op is
// invalid, nothing is written. Otherwise the run, its events and owner files are written once.
import { existsSync, statSync } from "node:fs";
import { orchHome } from "../state/home.ts";
import { acquireLock } from "../state/lock.ts";
import { appendEvents, loadRun, saveRun, type RunState } from "../state/store.ts";
import {
  applyAdd,
  applyReport,
  applyUpdate,
  doneVerify,
  loadChain,
  loadHub,
  newCtx,
  OpError,
  parseAddArgs,
  parseReportArgs,
  parseUpdateArgs,
  trimnl,
  USAGE,
  type Ctx,
} from "../runs/node.ts";
import { errLine, finalFill, flushStderr, resolveRun, writeOwners } from "./node.ts";

export const BATCH_LOCK_TRIES = 150; // 30 s at 200 ms: NODE_BATCH_LOCK_WAIT_SECS in batch.sh
export const BATCH_LOCK_SLEEP_MS = 200;

const KNOWN: Record<string, string[]> = {
  add: ["op", "id", "label", "goal", "after", "profile", "role", "tier", "model", "plan_backed", "acceptance"],
  report: ["op", "id", "model", "input_tokens", "output_tokens", "cache_read_tokens", "usd", "note"],
  update: ["op", "id", "status", "job", "error", "at", "owner", "force", "after", "needs_user", "clear_needs_user", "hold", "clear_hold"],
};

type Obj = Record<string, unknown>;

const isNull = (v: unknown) => v === undefined || v === null || v === false;

function req(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v === "string" && v !== "") return v;
  throw new OpError(`"${k}" is required (a non-empty string)`);
}

function opt(o: Obj, k: string, flag: string): string[] {
  const v = o[k];
  if (isNull(v)) return [];
  if (typeof v === "string") return [flag, v];
  if (typeof v === "number") return [flag, String(v)];
  throw new OpError(`"${k}" must be a string or a number`);
}

function flagOf(o: Obj, k: string, flag: string): string[] {
  const v = o[k];
  if (v === true) return [flag];
  if (isNull(v)) return [];
  throw new OpError(`"${k}" must be true or false`);
}

function afterList(o: Obj): string[] {
  const v = o.after;
  if (isNull(v)) return [];
  let s: string;
  if (typeof v === "string") s = v;
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) s = v.join(",");
  else throw new OpError(`"after" must be a string or an array of strings`);
  return s === "" ? [] : ["--after", s];
}

function updateAfter(o: Obj): string[] {
  if (!("after" in o)) return [];
  const v = o.after;
  if (typeof v === "string") return ["--after", v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return ["--after", v.join(",")];
  throw new OpError(`"after" must be a string or an array of strings`);
}

// build (batch.sh NODE_BATCH_DEFS): one op object -> argv. The first word is the verb.
export function buildOp(obj: unknown): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new OpError("not a JSON object");
  const o = obj as Obj;
  const op = o.op;
  if (typeof op !== "string" || !Object.hasOwn(KNOWN, op)) throw new OpError(`"op" must be add, report or update`);
  const extra = Object.keys(o).filter((k) => !KNOWN[op]!.includes(k)).sort();
  if (extra.length > 0) throw new OpError(`unknown field(s) for ${op}: ${extra.join(", ")}`);
  if (op === "add") {
    if (isNull(o.label) && isNull(o.goal)) throw new OpError(`"label" (or "goal") is required`);
    const id = req(o, "id");
    const label = !isNull(o.label) ? req(o, "label") : req(o, "goal");
    return [
      "add", id, label, ...afterList(o), ...opt(o, "profile", "--profile"), ...opt(o, "role", "--role"),
      ...opt(o, "tier", "--tier"), ...opt(o, "model", "--model"), ...flagOf(o, "plan_backed", "--plan-backed"),
      ...opt(o, "acceptance", "--acceptance"),
    ];
  }
  if (op === "report") {
    const id = req(o, "id");
    return [
      "report", id, ...opt(o, "model", "--model"), ...opt(o, "input_tokens", "--input-tokens"),
      ...opt(o, "output_tokens", "--output-tokens"), ...opt(o, "cache_read_tokens", "--cache-read-tokens"),
      ...opt(o, "usd", "--usd"), ...opt(o, "note", "--note"),
    ];
  }
  if (o.needs_user != null && o.clear_needs_user === true) {
    throw new OpError(`"needs_user" and "clear_needs_user" cannot be combined`);
  }
  if (o.hold != null && o.clear_hold === true) throw new OpError(`"hold" and "clear_hold" cannot be combined`);
  let status: string[] = [];
  if (o.status !== undefined && o.status !== null && o.status !== "") status = [req(o, "status")];
  else if (Object.hasOwn(o, "status") && o.status !== null) throw new OpError(`"status" must be a non-empty string`);
  const id = req(o, "id");
  return [
    "update", id, ...status, ...opt(o, "job", "--job"), ...opt(o, "error", "--error"), ...opt(o, "at", "--at"),
    ...opt(o, "owner", "--owner"), ...flagOf(o, "force", "--force"), ...updateAfter(o),
    ...opt(o, "needs_user", "--needs-user"), ...flagOf(o, "clear_needs_user", "--clear-needs-user"),
    ...opt(o, "hold", "--hold"), ...flagOf(o, "clear_hold", "--clear-hold"),
  ];
}

interface Line {
  line: number;
  args?: string[];
  err?: string;
}

// Non-blank lines, numbered by their position in the input (blank lines still count).
export function parseLines(text: string): Line[] {
  const out: Line[] = [];
  text.split("\n").forEach((raw, i) => {
    const t = raw.replace(/\r$/, "");
    if (!/\S/.test(t)) return;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      out.push({ line: i + 1, err: "invalid JSON" });
      return;
    }
    try {
      out.push({ line: i + 1, args: buildOp(obj) });
    } catch (e) {
      out.push({ line: i + 1, err: e instanceof OpError ? e.message : String(e) });
    }
  });
  return out;
}

// Applies one op. Returns its summary (`add x "label"`, `report x`, `update x -> done`).
function applyOp(run: RunState, args: string[], ctx: Ctx): string {
  const [verb, ...rest] = args;
  if (verb === "add") return applyAdd(run, parseAddArgs(rest), ctx);
  if (verb === "report") return applyReport(run, parseReportArgs(rest), ctx);
  return applyUpdate(run, parseUpdateArgs(rest), ctx);
}

function usageFail(msg: string): number {
  errLine(msg);
  return 2;
}

export async function nodeBatch(args: string[]): Promise<number> {
  const home = orchHome();
  const runArg = args[0] ?? "";
  if (!runArg) return usageFail(`usage: ${USAGE.batch}`);
  let src = "";
  let dry = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--file") {
      src = args[i + 1] ?? "";
      i++;
      if (!src) return usageFail("node batch: --file needs a path");
    } else if (args[i] === "--dry-run") dry = true;
    else return usageFail(`node batch: unknown argument ${args[i]}\n  usage: ${USAGE.batch}`);
  }
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  if (!(await loadRun(home, runId))) return usageFail(`run ${runId}: unknown run`);

  let text: string;
  if (src) {
    if (!existsSync(src) || !statSync(src).isFile()) return usageFail(`node batch: cannot read ${src}`);
    text = await Bun.file(src).text();
  } else {
    if (process.stdin.isTTY) return usageFail(`node batch: pipe the ops on stdin or pass --file\n  usage: ${USAGE.batch}`);
    text = (globalThis as any).__orchStdin ?? (await Bun.stdin.text());
  }
  const lines = parseLines(text);
  if (lines.length === 0) return usageFail("node batch: no ops");

  const lock = await acquireLock(home, `run-${runId}`, BATCH_LOCK_TRIES, BATCH_LOCK_SLEEP_MS);
  if (!lock) return usageFail(`node batch: run ${runId} is locked by another batch`);
  try {
    const run = await loadRun(home, runId);
    if (!run) return usageFail(`run ${runId}: unknown run`);
    const ctx = newCtx(home, runId, { batch: true, hub: await loadHub(home), chain: await loadChain(home, run) });
    const beforeDone = new Set<string>(run.nodes.filter((n) => n.status === "done").map((n) => n.id as string));

    const errs: string[] = [];
    const summaries: Array<{ line: number; summary: string }> = [];
    for (const l of lines) {
      if (l.err !== undefined) {
        errs.push(`line ${l.line}: ${trimnl(l.err)}`);
        continue;
      }
      try {
        summaries.push({ line: l.line, summary: applyOp(run, l.args ?? [], ctx) });
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        errs.push(`line ${l.line}: ${trimnl(e.message)}`);
      }
    }
    if (errs.length > 0) {
      flushStderr(ctx);
      for (const e of errs) errLine(e);
      errLine(`node batch: ${errs.length} invalid op(s) of ${lines.length}; nothing applied`);
      return 2;
    }
    if (dry) {
      for (const s of summaries) process.stdout.write(`line ${s.line}: would ${s.summary}\n`);
      process.stdout.write(`node batch: ${summaries.length} op(s) valid (dry run, nothing applied)\n`);
      return 0;
    }
    // A node that turned done in this batch gets its done-verify, after the batch events (as batch.sh does).
    const verified = new Set<string>();
    for (const id of ctx.verify) {
      if (verified.has(id) || beforeDone.has(id)) continue;
      verified.add(id);
      const n = run.nodes.find((x) => x.id === id);
      if (n?.status === "done") doneVerify(run, id, ctx);
    }
    await saveRun(home, runId, run);
    await appendEvents(home, runId, ctx.events);
    await writeOwners(home, ctx);
    flushStderr(ctx);
    if (ctx.events.some((e: any) => ["done", "error", "skipped"].includes(e.to))) await finalFill(home, runId);
    for (const s of summaries) process.stdout.write(`line ${s.line}: ${s.summary} ok\n`);
    process.stdout.write(`node batch: applied ${summaries.length} op(s)\n`);
    return 0;
  } finally {
    await lock.release();
  }
}
