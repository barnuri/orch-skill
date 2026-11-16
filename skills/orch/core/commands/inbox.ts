// `node tell`, `node ask [--wait]`, `node inbox`. Port of lib/runs/inbox.sh (same files, same output).
// Bun built-ins only. Every message is one file runs/<run>/inbox/<node>/<seq>.json; the seq is
// allocated under the per-run lock `run-<id>` (same lock as lib/runs/runs.sh run_lock).
// Not ported yet: herdr push (a message whose node has a herdr pane stays pending here) and
// `node answer`, `run broadcast`, `run rule`, `run messages`.
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, writeJsonAtomic, appendEvents } from "../state/store.ts";
import { acquireLock } from "../state/lock.ts";
import { nowIso } from "../state/clock.ts";

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

async function appendRunEvent(
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
async function inboxNew(home: string, run: string, to: string, from: string, kind: string, text: string): Promise<string> {
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

class LockBusy extends Error {
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

// Delivery: a herdr pane is not ported, so the message stays pending (see header).
async function sendTell(home: string, run: string, node: string, from: string, text: string): Promise<number> {
  const path = await inboxNew(home, run, node, from, "tell", text);
  const id = (await readMsg(path)).id;
  await appendRunEvent(home, run, "message", node, from, "pending", text);
  out(`${id} ${node} pending\n`);
  return 0;
}

export async function cmdNodeTell(args: string[]): Promise<number> {
  const a = takeArgs(args);
  if (!a) {
    err(`usage: ${NODE_TELL_USAGE}\n`);
    return 2;
  }
  const home = orchHome();
  const st = await requireRun(home, a.run);
  if (!st) return 2;
  if (!requireNode(st, a.node)) return 2;
  try {
    return await sendTell(home, a.run, a.node, a.from || "orch", a.text);
  } catch (e) {
    if (e instanceof LockBusy) {
      err(`run ${a.run}: state is locked by another writer\n`);
      return 75;
    }
    throw e;
  }
}

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
  if (!/^[0-9]+$/.test(timeout)) {
    err(`usage: ${NODE_ASK_USAGE}\n`);
    return 2;
  }
  const a = takeArgs(rest);
  if (!a) {
    err(`usage: ${NODE_ASK_USAGE}\n`);
    return 2;
  }
  const home = orchHome();
  const st = await requireRun(home, a.run);
  if (!st) return 2;
  if (!requireNode(st, a.node)) return 2;
  let path: string;
  try {
    path = await inboxNew(home, a.run, "orch", a.node, "ask", a.text);
  } catch (e) {
    if (e instanceof LockBusy) {
      err(`run ${a.run}: state is locked by another writer\n`);
      return 75;
    }
    throw e;
  }
  const m = await readMsg(path);
  m.answer = null;
  m.answered_at = null;
  m.waiting = wait;
  await writeJsonAtomic(path, m);
  const id: string = m.id;
  await appendRunEvent(home, a.run, "ask", a.node, "", "", `${id}: ${a.text}`);
  if (!wait) {
    out(`${id} asked\n`);
    return 0;
  }
  const deadline = Date.now() + parseInt(timeout, 10) * 1000;
  const pollMs = (parseFloat(process.env.ORCH_ASK_POLL_SECS || "2") || 2) * 1000;
  for (;;) {
    const cur = await readMsg(path);
    if (cur.answer) {
      // The answer was printed here, so the node's copy counts as delivered.
      await ackAnswer(home, a.run, a.node, id);
      out(`${cur.answer}\n`);
      return 0;
    }
    if (Date.now() >= deadline) {
      err(`node ask: no answer to ${id} after ${timeout}s\n`);
      return 4;
    }
    await Bun.sleep(pollMs);
  }
}

// Marks the node's pending answer to <ask-id> delivered (via ask-wait).
async function ackAnswer(home: string, run: string, node: string, askId: string): Promise<void> {
  for (const f of await inboxFiles(home, run, node)) {
    const m = await readMsg(f);
    if (m.status === "pending" && (m.reply_to ?? "") === askId) await markDelivered(f, "ask-wait");
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
    else {
      err(`usage: ${NODE_INBOX_USAGE}\n`);
      return 2;
    }
  }
  if (!runId || !node) {
    err(`usage: ${NODE_INBOX_USAGE}\n`);
    return 2;
  }
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
    pending.push(m); // the object as it was before the mark, like bash
    if (!peek) await markDelivered(f, via);
  }
  if (json) {
    out(JSON.stringify(pending) + "\n");
    return 0;
  }
  for (const m of pending) out(`[${m.id} from ${m.from}] ${m.text}\n`);
  return 0;
}
