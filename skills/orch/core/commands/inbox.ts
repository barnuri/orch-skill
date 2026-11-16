// Messaging and the coordinator bridge. Port of lib/runs/inbox.sh (same files, same output).
// Every message is one file runs/<run>/inbox/<node>/<seq>.json; the seq is allocated under the
// per-run lock `run-<id>`. Delivery: herdr pane of the node's job, else pending (node inbox / retry).
// Asks and urgent tells go to inbox/orch and are typed into the coordinator pane (user herdr socket).
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, writeJsonAtomic, appendEvents } from "../state/store.ts";
import { acquireLock } from "../state/lock.ts";
import { nowIso } from "../state/clock.ts";
import { herdrCli, herdrEnabled } from "../adapters/herdr.ts";
import { findNode } from "../runs/node.ts";
import { mutateRun } from "./node.ts";

export const NODE_TELL_USAGE = 'dispatch.sh node tell <run-id> <node-id> "<text>" [--from NAME]';
export const NODE_ASK_USAGE = 'dispatch.sh node ask <run-id> <node-id> "<question>" [--wait] [--timeout SECS]';
export const NODE_INBOX_USAGE = "dispatch.sh node inbox <run-id> <node-id> [--json] [--peek] [--ack <id>] [--via NAME]";
const INBOX_ASK_WAIT_SECS = 1800;
const LOCK_TRIES = 600; // run_lock: 600 x 50 ms
const LOCK_SLEEP_MS = 50;

type Msg = Record<string, any>;

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

function inboxDir(home: string, run: string, node: string): string {
  return join(paths.runs(home), run, "inbox", node);
}

// Message files of a node in seq order (numeric sort of the basename, as `sort -n`).
export async function inboxFiles(home: string, run: string, node: string): Promise<string[]> {
  const dir = inboxDir(home, run, node);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".json"))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((n) => join(dir, n));
}

export async function readMsg(file: string): Promise<Msg> {
  return (await Bun.file(file).json()) as Msg;
}

export async function appendRunEvent(
  home: string,
  run: string,
  kind: string,
  node: string,
  from: string,
  to: string,
  note: string,
): Promise<void> {
  const e = {
    at: nowIso(),
    kind,
    node: node || null,
    from: from || null,
    to: to || null,
    note: note || null,
    by: process.env.ORCH_EVENT_BY || "cli",
  };
  await appendEvents(home, run, [e]);
}

// Stores a pending message and returns its path. The seq is allocated under the run lock.
export async function inboxNew(home: string, run: string, to: string, from: string, kind: string, text: string): Promise<string> {
  const dir = inboxDir(home, run, to);
  await mkdir(dir, { recursive: true });
  const seqFile = join(paths.runs(home), run, "inbox", ".seq");
  const lock = await acquireLock(home, `run-${run}`, LOCK_TRIES, LOCK_SLEEP_MS);
  if (!lock) throw new LockBusy(run);
  try {
    const cur = parseInt((await Bun.file(seqFile).text().catch(() => "0")).trim(), 10) || 0;
    const seq = cur + 1;
    await Bun.write(seqFile, `${seq}\n`);
    const path = join(dir, `${seq}.json`);
    const msg: Msg = {
      id: `m${seq}`,
      seq,
      from,
      to,
      kind,
      at: nowIso(),
      text,
      delivered_at: null,
      via: null,
      tries: 0,
      status: "pending",
      last_error: null,
    };
    await writeJsonAtomic(path, msg);
    return path;
  } finally {
    await lock.release();
  }
}

export class LockBusy extends Error {
  constructor(readonly run: string) {
    super("locked");
  }
}

export async function markDelivered(path: string, via: string): Promise<void> {
  const m = await readMsg(path);
  m.status = "delivered";
  m.delivered_at = nowIso();
  m.via = via;
  m.last_error = null;
  await writeJsonAtomic(path, m);
}

// Shared parse of <run> <node> "<text>" [--from NAME].
function takeArgs(args: string[]): { run: string; node: string; text: string; from: string } | null {
  let run = "";
  let node = "";
  let text = "";
  let from = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from") from = args[++i] ?? "";
    else if (!run) run = a;
    else if (!node) node = a;
    else text = text ? `${text} ${a}` : a;
  }
  return run && node && text ? { run, node, text, from } : null;
}

// Returns the run state, or prints the bash message and returns null (exit 2).
async function requireRun(home: string, run: string): Promise<any | null> {
  const st = await loadRun(home, run);
  if (!st) {
    err(`run ${run}: unknown run\n`);
    return null;
  }
  return st;
}

function requireNode(st: any, node: string): boolean {
  if (st.nodes.some((n: any) => n.id === node)) return true;
  err(`node ${node}: not in this run\n`);
  return false;
}


const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lockMsg = (run: string) => err(`run ${run}: state is locked by another writer\n`);

async function patchMsg(path: string, fn: (m: Msg) => void): Promise<Msg> {
  const m = await readMsg(path);
  fn(m);
  await writeJsonAtomic(path, m);
  return m;
}

// The herdr pane of the node's running job; "" when none.
async function nodePane(home: string, run: string, node: string): Promise<string> {
  const st = await loadRun(home, run);
  const n = st ? findNode(st, node) : undefined;
  if (!n || n.status !== "running" || !n.job_id) return "";
  const t = await Bun.file(join(paths.jobs(home), String(n.job_id), "herdr_pane")).text().catch(() => "");
  return t.split("\n")[0].trim();
}

// One push attempt. Returns delivered | pending | failed.
export async function inboxDeliver(home: string, run: string, node: string, path: string): Promise<string> {
  const m = await readMsg(path);
  if (m.status !== "pending") return m.status;
  const pane = await nodePane(home, run, node);
  if (!pane || !(await herdrEnabled(home))) return "pending";
  const text = `[orch message ${m.id} from ${m.from}] ${m.text}`;
  const a = await herdrCli(home, ["pane", "send-text", pane, text]);
  const b = a.ok ? await herdrCli(home, ["pane", "send-keys", pane, "Enter"]) : a;
  if (a.ok && b.ok) {
    await markDelivered(path, "herdr");
    return "delivered";
  }
  const tries = (m.tries ?? 0) + 1;
  const e = (b.stderr + b.stdout).trim() || "herdr send failed";
  if (tries >= INBOX_MAX_TRIES) {
    await patchMsg(path, (x) => { x.tries = tries; x.status = "failed"; x.last_error = e; });
    await appendRunEvent(home, run, "message", node, "", "failed", `${m.id} failed after ${tries} tries`);
    return "failed";
  }
  await patchMsg(path, (x) => { x.tries = tries; x.last_error = e; });
  return "pending";
}
const INBOX_MAX_TRIES = 3;

// Store, try to push, print "<id> <node> <result>".
export async function inboxSend(home: string, run: string, node: string, from: string, kind: string, text: string): Promise<string> {
  const path = await inboxNew(home, run, node, from, kind, text);
  const result = await inboxDeliver(home, run, node, path);
  await appendRunEvent(home, run, "message", node, from, result, text);
  out(`${(await readMsg(path)).id} ${node} ${result}\n`);
  return result;
}

export async function cmdNodeTell(args: string[]): Promise<number> {
  const a = takeArgs(args);
  if (!a) return (err(`usage: ${NODE_TELL_USAGE}\n`), 2);
  const home = orchHome();
  const st = await requireRun(home, a.run);
  if (!st) return 2;
  try {
    if (a.node === "coordinator") {
      const from = a.from || "orch";
      const path = await inboxNew(home, a.run, "orch", from, "tell", a.text);
      const result = await coordDeliver(home, a.run, path);
      await appendRunEvent(home, a.run, "message", "", from, result, a.text);
      out(`${(await readMsg(path)).id} coordinator ${result}\n`);
      return 0;
    }
    if (!requireNode(st, a.node)) return 2;
    await inboxSend(home, a.run, a.node, a.from || "orch", "tell", a.text);
    return 0;
  } catch (e) {
    if (e instanceof LockBusy) return (lockMsg(a.run), 75);
    throw e;
  }
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").replace(/^ | $/g, "").slice(0, 200);

export async function cmdNodeAsk(args: string[]): Promise<number> {
  let wait = false;
  let timeout = String(INBOX_ASK_WAIT_SECS);
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wait") wait = true;
    else if (a === "--timeout") timeout = args[++i] ?? "";
    else rest.push(a);
  }
  if (!/^[0-9]+$/.test(timeout)) return (err(`usage: ${NODE_ASK_USAGE}\n`), 2);
  const a = takeArgs(rest);
  if (!a) return (err(`usage: ${NODE_ASK_USAGE}\n`), 2);
  const home = orchHome();
  const st = await requireRun(home, a.run);
  if (!st) return 2;
  if (!requireNode(st, a.node)) return 2;
  const unread: string[] = [];
  for (const f of await inboxFiles(home, a.run, a.node)) {
    const m = await readMsg(f);
    if (m.kind === "answer" && m.status === "pending") unread.push(`- ${m.id}: ${m.text}`);
  }
  if (unread.length) {
    err(`Unread answers from the coordinator:\n${unread.join("\n")}\nread your answers first (dispatch.sh node inbox ${a.run} ${a.node})\n`);
    return 3;
  }
  const want = norm(a.text);
  for (const f of await inboxFiles(home, a.run, "orch")) {
    const m = await readMsg(f);
    if (m.kind !== "ask" || m.from !== a.node || norm(String(m.text)) !== want) continue;
    out(`${m.id} duplicate of an open question; not stored again\n`);
    if (m.answer) out(`answer: ${m.answer}\n`);
    return 0;
  }
  let path: string;
  try {
    path = await inboxNew(home, a.run, "orch", a.node, "ask", a.text);
  } catch (e) {
    if (e instanceof LockBusy) return (lockMsg(a.run), 75);
    throw e;
  }
  const m = await patchMsg(path, (x) => { x.answer = null; x.answered_at = null; x.waiting = wait; });
  const id: string = m.id;
  await appendRunEvent(home, a.run, "ask", a.node, "", "", `${id}: ${a.text}`);
  await coordDeliver(home, a.run, path);
  if (!wait) return (out(`${id} asked\n`), 0);
  const secs = Math.min(parseInt(timeout, 10), 90);
  const deadline = Date.now() + secs * 1000;
  const pollMs = (parseFloat(process.env.ORCH_ASK_POLL_SECS || "2") || 2) * 1000;
  for (;;) {
    const cur = await readMsg(path).catch(() => ({}) as Msg);
    if (cur.answer) {
      await ackAnswer(home, a.run, a.node, id);
      out(`${cur.answer}\n`);
      return 0;
    }
    if (Date.now() >= deadline) {
      await patchMsg(path, (x) => { x.waiting = false; x.answered_late_expected = true; });
      err(`node ask: no answer to ${id} after ${secs}s; continue with your best choice, a late answer is delivered as a message\n`);
      return 4;
    }
    if (cur.delivered_at == null) await coordSweep(home, a.run).catch(() => []);
    await sleepMs(pollMs);
  }
}

async function ackAnswer(home: string, run: string, node: string, askId: string): Promise<void> {
  for (const f of await inboxFiles(home, run, node)) {
    const m = await readMsg(f);
    if (m.status === "pending" && (m.reply_to ?? "") === askId) await markDelivered(f, "ask-wait");
  }
}

export async function cmdNodeAnswer(args: string[]): Promise<number> {
  const USAGE = 'dispatch.sh node answer <run-id> <node-id> "<answer>" [--ask <id>]';
  let ask = "";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ask") ask = args[++i] ?? "";
    else rest.push(args[i]);
  }
  const a = takeArgs(rest);
  if (!a) return (err(`usage: ${USAGE}\n`), 2);
  const home = orchHome();
  if (!(await requireRun(home, a.run))) return 2;
  const st = await loadRun(home, a.run);
  if (!requireNode(st, a.node)) return 2;
  let path = "";
  for (const f of await inboxFiles(home, a.run, "orch")) {
    const m = await readMsg(f);
    if (ask ? m.id === ask : m.kind === "ask" && m.from === a.node && m.answer == null) { path = f; break; }
  }
  if (!path) return (err(`node answer: no open ask from ${a.node}${ask ? ` with id ${ask}` : ""}\n`), 2);
  const m = await readMsg(path);
  if (m.from !== a.node) return (err(`node answer: ${ask} was not asked by ${a.node}\n`), 2);
  if (m.answer) return (err(`node answer: ${m.id} is already answered\n`), 2);
  ask = m.id;
  const late = m.answered_late_expected === true ? "(late, your ask had timed out) " : "";
  const from = a.from || "orch";
  try {
    const nodePath = await inboxNew(home, a.run, a.node, from, "answer", `Answer to ${ask}: ${late}${a.text}`);
    await patchMsg(nodePath, (x) => { x.reply_to = ask; });
    const at = nowIso();
    await patchMsg(path, (x) => {
      x.answer = a.text; x.answered_at = at; x.status = "delivered"; x.delivered_at = x.delivered_at ?? at; x.via = x.via ?? "answer";
    });
    const waiting = (await readMsg(path)).waiting === true;
    const res = waiting ? "pending" : await inboxDeliver(home, a.run, a.node, nodePath);
    await appendRunEvent(home, a.run, "message", a.node, from, res, `answer ${ask}: ${a.text}`);
    out(`${ask} answered ${a.node} ${res}\n`);
    return 0;
  } catch (e) {
    if (e instanceof LockBusy) return (lockMsg(a.run), 75);
    throw e;
  }
}

export async function cmdNodeInbox(args: string[]): Promise<number> {
  let runId = "";
  let node = "";
  let json = false;
  let peek = false;
  let ack = "";
  let via = "inbox";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--peek") peek = true;
    else if (a === "--ack") ack = args[++i] ?? "";
    else if (a === "--via") via = args[++i] || "inbox";
    else if (!runId) runId = a;
    else if (!node) node = a;
    else return (err(`usage: ${NODE_INBOX_USAGE}\n`), 2);
  }
  if (!runId || !node) return (err(`usage: ${NODE_INBOX_USAGE}\n`), 2);
  const home = orchHome();
  if (!(await requireRun(home, runId))) return 2;
  const files = await inboxFiles(home, runId, node);
  if (ack) {
    for (const f of files) {
      const m = await readMsg(f);
      if (m.id !== ack) continue;
      if (m.status !== "delivered") await markDelivered(f, via);
      out(`acked ${ack}\n`);
      return 0;
    }
    err(`node inbox: no message ${ack}\n`);
    return 2;
  }
  const pending: Msg[] = [];
  for (const f of files) {
    const m = await readMsg(f);
    if (m.status !== "pending") continue;
    pending.push(m);
    if (!peek) await markDelivered(f, via);
  }
  if (json) return (out(JSON.stringify(pending) + "\n"), 0);
  for (const m of pending) out(`[${m.id} from ${m.from}] ${m.text}\n`);
  return 0;
}

async function inboxAll(home: string, run: string): Promise<Msg[]> {
  const root = join(paths.runs(home), run, "inbox");
  const all: Msg[] = [];
  for (const d of await readdir(root).catch(() => [] as string[])) {
    for (const f of await inboxFiles(home, run, d)) all.push(await readMsg(f).catch(() => ({}) as Msg));
  }
  return all.filter((m) => m.seq !== undefined).sort((x, y) => x.seq - y.seq);
}

async function inboxRetryRun(home: string, run: string): Promise<void> {
  const root = join(paths.runs(home), run, "inbox");
  if (!(await stat(root).catch(() => null))) return void out("retried 0\n");
  const sw = await coordSweep(home, run);
  for (const l of sw.slice(0, -1)) out(l + "\n");
  let n = 0;
  for (const node of (await readdir(root)).sort()) {
    if (node === "orch" || node.startsWith(".")) continue;
    if (!(await nodePane(home, run, node))) continue;
    for (const f of await inboxFiles(home, run, node)) {
      const m = await readMsg(f);
      if (m.status !== "pending") continue;
      const r = await inboxDeliver(home, run, node, f);
      n++;
      out(`${m.id} ${node} ${r}\n`);
    }
  }
  out(`retried ${n}\n`);
}

export async function cmdRunMessages(args: string[]): Promise<number> {
  const USAGE = "dispatch.sh run messages <run-id> [--json] | run messages <run-id> retry";
  const run = args[0] ?? "";
  if (!run) return (err(`usage: ${USAGE}\n`), 2);
  const home = orchHome();
  if (!(await requireRun(home, run))) return 2;
  switch (args[1] ?? "") {
    case "retry": await inboxRetryRun(home, run); return 0;
    case "--json": out(JSON.stringify(await inboxAll(home, run)) + "\n"); return 0;
    case "":
      for (const m of await inboxAll(home, run)) out(`${m.id} ${m.from}->${m.to} [${m.kind}] ${m.status}${m.via ? ` via ${m.via}` : ""}: ${m.text}\n`);
      return 0;
    default: return (err(`usage: ${USAGE}\n`), 2);
  }
}

async function inboxBroadcast(home: string, run: string, from: string, kind: string, text: string): Promise<void> {
  const st = await loadRun(home, run);
  let n = 0;
  for (const node of st!.nodes.filter((x) => x.status === "running")) {
    await inboxSend(home, run, node.id, from, kind, text);
    n++;
  }
  out(`broadcast ${n}\n`);
}

export async function cmdRunBroadcast(args: string[]): Promise<number> {
  let run = "";
  let text = "";
  let from = "orch";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") from = args[++i] || "orch";
    else if (!run) run = args[i];
    else text = text ? `${text} ${args[i]}` : args[i];
  }
  if (!run || !text) return (err('usage: dispatch.sh run broadcast <run-id> "<text>" [--from NAME]\n'), 2);
  const home = orchHome();
  if (!(await requireRun(home, run))) return 2;
  try {
    await inboxBroadcast(home, run, from, "broadcast", text);
  } catch (e) {
    if (e instanceof LockBusy) return (lockMsg(run), 75);
    throw e;
  }
  return 0;
}

export async function cmdRunRule(args: string[]): Promise<number> {
  const USAGE = 'dispatch.sh run rule add <run-id> "<text>" | run rule list <run-id> [--json]';
  const [verb = "", run = ""] = args;
  const home = orchHome();
  if (verb === "add") {
    const text = args.slice(2).join(" ");
    if (!run || !text) return (err(`usage: ${USAGE}\n`), 2);
    if (!(await requireRun(home, run))) return 2;
    let id = "";
    const rc = await mutateRun(home, run, (r, ctx) => {
      r.rules = r.rules ?? [];
      id = `r${r.rules.length + 1}`;
      r.rules.push({ id, text, at: ctx.now });
      ctx.events.push({ at: ctx.now, kind: "rule", node: null, from: null, to: null, note: text, by: ctx.by });
    });
    if (rc !== 0) return rc;
    out(`rule ${id} added\n`);
    try {
      await inboxBroadcast(home, run, "orch", "rule", `New run rule: ${text}`);
    } catch (e) {
      if (e instanceof LockBusy) return (lockMsg(run), 75);
      throw e;
    }
    return 0;
  }
  if (verb === "list") {
    if (!run) return (err(`usage: ${USAGE}\n`), 2);
    const st = await requireRun(home, run);
    if (!st) return 2;
    const rules = (st.rules ?? []) as any[];
    if (args[2] === "--json") out(JSON.stringify(rules) + "\n");
    else for (const r of rules) out(`${r.id} ${r.text}\n`);
    return 0;
  }
  return (err(`usage: ${USAGE}\n`), 2);
}

// ---- Coordinator bridge ---------------------------------------------------------------------------
// run.coordinator = {pane_id, socket_path, workspace_id, session_id, repo, harness, at, unreachable, ...}.

type CliOut = { ok: boolean; stdout: string; stderr: string };

// The user's herdr through its own socket, never the orch instance.
async function coordCli(sock: string, args: string[]): Promise<CliOut> {
  try {
    const p = Bun.spawn(["herdr", ...args], { env: { ...process.env, HERDR_SOCKET_PATH: sock }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill("SIGKILL"), (parseFloat(process.env.ORCH_HERDR_CALL_TIMEOUT || "8") || 8) * 1000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(t);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

function walk(v: any, fn: (o: any) => void): void {
  if (v && typeof v === "object") {
    if (!Array.isArray(v)) fn(v);
    for (const k of Object.values(v)) walk(k, fn);
  }
}

function jparse(t: string): any {
  try { return JSON.parse(t); } catch { return null; }
}

export function coordSessionOf(json: string): string {
  let sid = "";
  walk(jparse(json), (o) => { const v = o.agent_session?.value; if (!sid && v) sid = String(v); });
  return sid;
}

function coordinatorHarness(): string {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (process.env.OPENCODE || process.env.OPENCODE_CONFIG) return "opencode";
  return "unknown";
}

async function coordOf(home: string, run: string): Promise<any | null> {
  return (await loadRun(home, run))?.coordinator ?? null;
}

export async function coordinatorRecord(home: string, run: string): Promise<number> {
  const pane = process.env.HERDR_PANE_ID ?? "";
  const sock = process.env.HERDR_SOCKET_PATH ?? "";
  const ws = process.env.HERDR_WORKSPACE_ID ?? "";
  if (!pane || !sock) {
    err("run set coordinator: HERDR_PANE_ID and HERDR_SOCKET_PATH must be set (run in the coordinator pane)\n");
    return 2;
  }
  const sid = coordSessionOf((await coordCli(sock, ["pane", "get", pane])).stdout);
  const rc = await mutateRun(home, run, (r, ctx) => {
    r.coordinator = { pane_id: pane, socket_path: sock, workspace_id: ws, session_id: sid, repo: realpathSync(process.cwd()), harness: coordinatorHarness(), at: ctx.now, unreachable: null, candidates: null, backlog_pending: true };
    ctx.events.push({ at: ctx.now, kind: "note", node: null, from: null, to: null, note: `coordinator set: pane ${pane}`, by: ctx.by });
  });
  if (rc !== 0) return rc;
  await coordFlushBacklog(home, run).catch(() => undefined);
  out(`coordinator: ${run} ${pane}\n`);
  return 0;
}

// Records the coordinator when the calling env has one; silent otherwise.
export async function coordinatorAutoRecord(home: string, run: string): Promise<void> {
  if (!process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
  if (!(await loadRun(home, run))) return;
  const w = process.stdout.write;
  process.stdout.write = (() => true) as any;
  try { await coordinatorRecord(home, run); } finally { process.stdout.write = w; }
}

async function coordTouch(home: string, run: string): Promise<void> {
  const c = await coordOf(home, run);
  if (!c) return;
  const r = await coordCli(c.socket_path, ["pane", "get", c.pane_id]);
  if (!r.ok) return;
  const sid = coordSessionOf(r.stdout);
  await mutateRun(home, run, (st, ctx) => {
    if (!st.coordinator) return;
    st.coordinator.at = ctx.now;
    if (sid) st.coordinator.session_id = sid;
  });
}

async function coordCandidates(home: string, c: any): Promise<any[]> {
  const rows: any[] = [];
  const nodePanes = new Set<string>();
  for (const j of await readdir(paths.jobs(home)).catch(() => [] as string[])) {
    const t = await Bun.file(join(paths.jobs(home), j, "herdr_pane")).text().catch(() => "");
    for (const l of t.split("\n")) if (l) nodePanes.add(l);
  }
  const def = join(process.env.HOME || homedir(), ".config/herdr/herdr.sock");
  const socks = c.socket_path === def ? [c.socket_path] : [c.socket_path, def];
  for (const sock of socks) {
    if (!(await stat(sock).catch(() => null))) continue;
    const l = await coordCli(sock, ["pane", "list"]);
    if (!l.ok) continue;
    for (const p of jparse(l.stdout)?.result?.panes ?? []) {
      if (!p.pane_id || nodePanes.has(p.pane_id)) continue;
      const g = await coordCli(sock, ["pane", "get", p.pane_id]);
      if (!g.ok) continue;
      const info = jparse(g.stdout);
      let agent = "";
      walk(info, (o) => { if (!agent && typeof o.agent === "string") agent = o.agent; });
      rows.push({ socket_path: sock, pane_id: p.pane_id, workspace_id: p.workspace_id, cwd: p.cwd, session_id: coordSessionOf(g.stdout), agent });
    }
  }
  return rows;
}

async function coordRepoint(home: string, run: string, row: any, reason: string): Promise<number> {
  let from = "none";
  const rc = await mutateRun(home, run, (st, ctx) => {
    from = st.coordinator?.pane_id ?? "none";
    const c = st.coordinator ?? {};
    st.coordinator = {
      ...c, socket_path: row.socket_path, pane_id: row.pane_id, workspace_id: row.workspace_id,
      session_id: row.session_id === "" ? c.session_id : row.session_id, at: ctx.now, unreachable: null, candidates: null,
      backlog_pending: true, last_repoint: { at: ctx.now, from, to: row.pane_id, reason },
    };
  });
  if (rc !== 0) return rc;
  await appendRunEvent(home, run, "message", "orch", "", "repointed", `coordinator repointed: ${from} -> ${row.pane_id} (${reason})`);
  return 0;
}

async function coordTryRepoint(home: string, run: string): Promise<boolean> {
  const c = await coordOf(home, run);
  if (!c) return false;
  const cands = await coordCandidates(home, c);
  const sid = c.session_id ?? "";
  const bySid = cands.filter((x) => sid !== "" && x.session_id === sid);
  const pick = bySid.length > 0 ? bySid : cands.filter((x) => x.agent === (c.harness ?? "") && x.cwd === (c.repo ?? ""));
  if (pick.length === 1) {
    await coordRepoint(home, run, pick[0], sid !== "" && pick.some((x) => x.session_id === sid) ? "same session" : "same harness and repo");
    return true;
  }
  await mutateRun(home, run, (st) => { if (st.coordinator) st.coordinator.candidates = pick; });
  return false;
}

async function coordPaneStatus(c: any): Promise<string> {
  const r = await coordCli(c.socket_path, ["pane", "get", c.pane_id]);
  if (!r.ok) return "gone";
  return /agent_status"?[ :=]+"?working/.test(r.stdout + r.stderr) ? "working" : "idle";
}

// Quiet: the screen is readable, unchanged over ORCH_COORD_SETTLE_SECS and its last line has no typed text.
async function coordPaneQuiet(c: any): Promise<boolean> {
  const read = () => coordCli(c.socket_path, ["pane", "read", c.pane_id, "--source", "visible", "--lines", "15"]);
  const a = await read();
  if (!a.ok) return false;
  await sleepMs((parseFloat(process.env.ORCH_COORD_SETTLE_SECS ?? "2") || 0) * 1000);
  const b = await read();
  if (!b.ok || a.stdout !== b.stdout) return false;
  const last = a.stdout.split("\n").filter((l) => /\S/.test(l)).pop() ?? "";
  return !/^[\s│|]*(❯|›|>|\$|%|#)\s*[^\s│|]/.test(last);
}

async function coordPendingAsks(home: string, run: string): Promise<number> {
  let n = 0;
  for (const f of await inboxFiles(home, run, "orch")) {
    const m = await readMsg(f);
    if (m.kind === "ask" && m.delivered_at == null) n++;
  }
  return n;
}

async function coordFlushBacklog(home: string, run: string): Promise<void> {
  const st = await loadRun(home, run);
  const c = st?.coordinator;
  if (!c || c.backlog_pending !== true) return;
  const n = await coordPendingAsks(home, run);
  if (n === 0) {
    await mutateRun(home, run, (s) => { if (s.coordinator) s.coordinator.backlog_pending = false; });
    return;
  }
  if ((await coordPaneStatus(c)) !== "idle" || !(await coordPaneQuiet(c))) return;
  const a = await coordCli(c.socket_path, ["pane", "send-text", c.pane_id, `${n} pending node questions`]);
  const b = a.ok ? await coordCli(c.socket_path, ["pane", "send-keys", c.pane_id, "Enter"]) : a;
  if (a.ok && b.ok) {
    await mutateRun(home, run, (s) => { if (s.coordinator) s.coordinator.backlog_pending = false; });
    await appendRunEvent(home, run, "message", "orch", "", "delivered", `backlog notice: ${n} pending node questions`);
  }
}

async function coordSetUnreachable(home: string, run: string, reason: string): Promise<void> {
  let was = false;
  await mutateRun(home, run, (st, ctx) => {
    was = (st.coordinator?.unreachable ?? null) != null;
    st.coordinator = st.coordinator ?? {};
    st.coordinator.unreachable = { reason, at: ctx.now };
  });
  if (!was) await appendRunEvent(home, run, "message", "orch", "", "unreachable", `coordinator unreachable: ${reason}; asks stay in inbox/orch`);
}

async function coordClearUnreachable(home: string, run: string): Promise<void> {
  if ((await coordOf(home, run))?.unreachable == null) return;
  await mutateRun(home, run, (st) => { if (st.coordinator) st.coordinator.unreachable = null; });
  await appendRunEvent(home, run, "message", "orch", "", "delivered", "coordinator reachable again");
}

async function coordCountTry(path: string, e: string): Promise<string> {
  await patchMsg(path, (x) => { x.tries = (x.tries ?? 0) + 1; x.last_error = e; });
  return "pending";
}

// One attempt to type the message into the coordinator pane: delivered | pending | unreachable | none.
export async function coordDeliver(home: string, run: string, path: string): Promise<string> {
  let c = await coordOf(home, run);
  if (!c) return "none";
  const m = await readMsg(path);
  if (m.delivered_at) return "delivered";
  let status = await coordPaneStatus(c);
  if (status === "gone" && (await coordTryRepoint(home, run))) {
    c = await coordOf(home, run);
    status = await coordPaneStatus(c);
  }
  if (status === "gone") return (await coordSetUnreachable(home, run, "pane or socket gone"), "unreachable");
  await coordClearUnreachable(home, run);
  if (status === "working") return coordCountTry(path, "coordinator pane is working");
  if (!(await coordPaneQuiet(c))) return coordCountTry(path, "coordinator is typing or the screen is changing");
  const text = String(m.text).replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = m.kind === "ask"
    ? `[orch ask #${m.id} from ${m.from}] ${text} | answer: dispatch.sh node answer ${run} ${m.from} ${m.id} "<text>"`
    : `[orch tell #${m.id} from ${m.from}] ${text}`;
  const a = await coordCli(c.socket_path, ["pane", "send-text", c.pane_id, line]);
  const b = a.ok ? await coordCli(c.socket_path, ["pane", "send-keys", c.pane_id, "Enter"]) : a;
  if (a.ok && b.ok) {
    await patchMsg(path, (x) => { x.status = "delivered"; x.delivered_at = nowIso(); x.via = "herdr-coordinator"; x.last_error = null; });
    await coordTouch(home, run);
    await appendRunEvent(home, run, "message", m.from, "orch", "delivered", `${m.id} to coordinator`);
    return "delivered";
  }
  const e = (b.stderr + b.stdout).trim() || "send failed";
  await patchMsg(path, (x) => { x.last_error = e; });
  await coordSetUnreachable(home, run, `send failed: ${e}`);
  return "unreachable";
}

// One pass over the undelivered messages to the coordinator, in order; stops at the first pending one.
export async function coordSweep(home: string, run: string): Promise<string[]> {
  const lines: string[] = [];
  await coordTouch(home, run);
  if ((await coordOf(home, run))?.unreachable != null) await coordTryRepoint(home, run).catch(() => false);
  await coordFlushBacklog(home, run).catch(() => undefined);
  let n = 0;
  for (const f of await inboxFiles(home, run, "orch")) {
    const m = await readMsg(f);
    if (!(m.delivered_at == null && m.status === "pending")) continue;
    const r = await coordDeliver(home, run, f);
    n++;
    lines.push(`${m.id} ${r}`);
    if (r === "pending" || r === "unreachable") break;
  }
  lines.push(`swept ${n}`);
  return lines;
}

export async function cmdRunRepoint(args: string[]): Promise<number> {
  const [run = "", sock = "", pane = ""] = args;
  if (!run || !sock || !pane) return (err("usage: dispatch.sh run repoint <run-id> <socket-path> <pane-id>   (a pane from the candidates of an unreachable coordinator)\n"), 2);
  const home = orchHome();
  if (!(await requireRun(home, run))) return 2;
  const c = await coordOf(home, run);
  if (!c) return (err(`run repoint: ${run} has no coordinator\n`), 2);
  const row = (await coordCandidates(home, c)).find((x) => x.socket_path === sock && x.pane_id === pane);
  if (!row) return (err(`run repoint: ${pane} in ${sock} is not a candidate pane\n`), 2);
  if ((await coordRepoint(home, run, row, "chosen by user")) !== 0) return 1;
  out(`repointed: ${run} ${pane}\n`);
  return 0;
}
