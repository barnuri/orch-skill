// orch node liveness, inbox and usage for opencode sessions that own a run node:
// - tells orch when the session goes idle, errors or works (`owner event`);
// - appends pending orch messages (`node tell`, `run broadcast`, answers) to the next tool result;
// - counts tool, skill and subagent calls into the node usage (`node usage --add`).
// Sessions without a registry file <orch-home>/owners/<session-id>.json cost one existsSync and nothing else.
// Source: orch-skill mods/opencode/orch-nodes.js, installed by install.sh as a symlink.
// Undo: delete the link (or restore the .orch-backup copy if one exists). Docs: orch references/harness-adapters.md

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ALIVE_MIN_MS = 30_000;
export const CLI_TIMEOUT_MS = 2_000;
export const NOTE_CHARS = 300;
export const RUNS_CACHE_MS = 5_000;
export const INBOX_MIN_MS = 5_000;
export const USAGE_FLUSH_MS = 30_000;
const USAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

export function orchHome(env = process.env) {
  return env.HARNESS_ORCH_HOME || join(homedir(), ".harness-orch");
}

export function registryPath(home, sessionID) {
  return join(home, "owners", `${String(sessionID).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function findDispatch(env = process.env, home = orchHome(env), read = (p) => readFileSync(p, "utf8")) {
  if (env.ORCH_DISPATCH) return env.ORCH_DISPATCH;
  try {
    const p = read(join(home, ".dispatch-path")).trim();
    return p || null;
  } catch {
    return null;
  }
}

function clip(text, n) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, n) : "";
}

function errorText(error) {
  return clip(error?.data?.message ?? error?.message ?? (typeof error === "string" ? error : ""), NOTE_CHARS) || "session error";
}

function lastAssistantText(properties) {
  const text = properties?.lastAssistantText ?? properties?.message?.text;
  return clip(text, NOTE_CHARS);
}

/** Maps an opencode event to an orch owner event, or null. `alive` is throttled by the caller. */
export function mapEvent(event) {
  const type = event?.type;
  const p = event?.properties ?? {};
  const id = typeof p.sessionID === "string" && p.sessionID ? p.sessionID : null;
  if (!id) return null;
  if (type === "session.idle") return { id, kind: "finished", note: lastAssistantText(p) };
  if (type === "session.error") return { id, kind: "failed", note: errorText(p.error) };
  if (type === "session.status") {
    const kind = typeof p.status === "string" ? p.status : p.status?.type;
    if (kind === "busy" || kind === "retry") return { id, kind: "alive", note: "" };
  }
  return null;
}

export function pendingPath(home, childID) {
  return join(home, "owners", "pending", `${String(childID).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** A child session (parentID set) from session.created / session.updated, or null. */
export function mapChild(event) {
  const type = event?.type;
  if (type !== "session.created" && type !== "session.updated") return null;
  const info = event?.properties?.info ?? event?.properties?.session ?? null;
  const child = typeof info?.id === "string" ? info.id : "";
  const parent = typeof info?.parentID === "string" ? info.parentID : "";
  if (!child || !parent) return null;
  const created = Number(info?.time?.created);
  return { child, parent, title: clip(info?.title, 200), created_ms: Number.isFinite(created) && created > 0 ? created : null };
}

/** {parentSessionID: runId} for runs whose state says running. Read at most every RUNS_CACHE_MS. */
export function createRunIndex({ home, readdir = readdirSync, read = (p) => readFileSync(p, "utf8"), now = Date.now } = {}) {
  let at = -Infinity;
  let index = new Map();
  return () => {
    if (now() - at < RUNS_CACHE_MS) return index;
    at = now();
    const next = new Map();
    try {
      for (const id of readdir(join(home, "runs"))) {
        try {
          const run = JSON.parse(read(join(home, "runs", id, "state.json")));
          if (run?.status === "running" && typeof run.harness_session === "string" && run.harness_session.startsWith("ses_")) {
            next.set(run.harness_session, run.run_id ?? id);
          }
        } catch {}
      }
    } catch {}
    index = next;
    return index;
  };
}

export function writeAtomic(path, text, { mkdir = (d) => mkdirSync(d, { recursive: true }), write = writeFileSync, rename = renameSync } = {}) {
  mkdir(join(path, ".."));
  const tmp = `${path}.tmp.${process.pid}`;
  write(tmp, text);
  rename(tmp, path);
}

export function createHandler({ exists = existsSync, run, now = Date.now, env = process.env, runIndex, write = writeAtomic } = {}) {
  const lastAlive = new Map();
  const pending = new Map();
  const started = new Set();
  const index = runIndex ?? createRunIndex({ home: orchHome(env), now });
  return (event) => {
    const child = mapChild(event);
    if (child) {
      const home = orchHome(env);
      const known = pending.has(child.child);
      const runId = known ? pending.get(child.child) : index().get(child.parent);
      if (!runId) return false;
      pending.set(child.child, runId);
      const record = { child: child.child, parent: child.parent, title: child.title, created: new Date(child.created_ms ?? now()).toISOString().replace(/\.\d+Z$/, "Z"), created_ms: child.created_ms ?? now() };
      write(pendingPath(home, child.child), JSON.stringify(record) + "\n");
      const dispatch = findDispatch(env, home);
      if (dispatch && !known) run("bash", [dispatch, "node", "bind-owners", "--run", runId]);
      return true;
    }
    const mapped = mapEvent(event);
    if (!mapped) return false;
    const home = orchHome(env);
    if (!exists(registryPath(home, mapped.id))) return false;
    if (mapped.kind === "alive") {
      const t = now();
      if (t - (lastAlive.get(mapped.id) ?? 0) < ALIVE_MIN_MS) return false;
      lastAlive.set(mapped.id, t);
    }
    const dispatch = findDispatch(env, home);
    if (!dispatch) return false;
    if (pending.has(mapped.id) && !started.has(mapped.id)) {
      started.add(mapped.id);
      run("bash", [dispatch, "owner", "event", mapped.id, "started", "--harness", "opencode"]);
    }
    const args = [dispatch, "owner", "event", mapped.id, mapped.kind, "--harness", "opencode"];
    if (mapped.note) args.push("--note", mapped.note);
    run("bash", args);
    return true;
  };
}

/** {run, node} for a session: its registry file, else the node this opencode process was dispatched for. */
export function nodeOf(home, sessionID, { env = process.env, read = (p) => readFileSync(p, "utf8") } = {}) {
  if (!sessionID) return null;
  try {
    const r = JSON.parse(read(registryPath(home, sessionID)));
    if (r?.run && r?.node) return { run: String(r.run), node: String(r.node) };
  } catch {}
  return env.ORCH_RUN_ID && env.ORCH_NODE_ID ? { run: env.ORCH_RUN_ID, node: env.ORCH_NODE_ID } : null;
}

/** True when runs/<run>/inbox/<node> holds a pending message. Plain file reads: no CLI call. */
export function hasPending(home, at, { readdir = readdirSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  const dir = join(home, "runs", at.run, "inbox", at.node);
  let names = [];
  try {
    names = readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      if (JSON.parse(read(join(dir, name)))?.status === "pending") return true;
    } catch {}
  }
  return false;
}

/** The text appended to a tool result: one line per message, the same shape the herdr push uses. */
export function formatMessages(messages) {
  return messages
    .filter((m) => m && typeof m.text === "string")
    .map((m) => (m.kind === "answer" ? `[orch answer ${m.reply_to ?? m.id} from ${m.from ?? "orch"}] ${m.text}` : `[orch message ${m.id} from ${m.from ?? "orch"}] ${m.text}`))
    .join("\n");
}

export function syncRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * (sessionID) => text of the node's pending messages, or null. At most one look per INBOX_MIN_MS per
 * session; `node inbox --json --via plugin` both reads and marks them delivered, so a message is shown once.
 */
export function createInbox({ env = process.env, now = Date.now, runSync = syncRun, readdir, read } = {}) {
  const last = new Map();
  return (sessionID) => {
    const home = orchHome(env);
    const at = nodeOf(home, sessionID, { env, ...(read ? { read } : {}) });
    if (!at) return null;
    const t = now();
    if (t - (last.get(sessionID) ?? -Infinity) < INBOX_MIN_MS) return null;
    last.set(sessionID, t);
    if (!hasPending(home, at, { ...(readdir ? { readdir } : {}), ...(read ? { read } : {}) })) return null;
    const dispatch = findDispatch(env, home);
    if (!dispatch) return null;
    const out = runSync("bash", [dispatch, "node", "inbox", at.run, at.node, "--json", "--via", "plugin"]);
    try {
      const text = formatMessages(JSON.parse(out ?? "[]"));
      return text || null;
    } catch {
      return null;
    }
  };
}

function usageName(raw) {
  const name = String(raw ?? "").replace(/[^A-Za-z0-9._:@-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return USAGE_NAME.test(name) ? name : null;
}

/** The usage terms one tool call adds: tool.<name>, plus skill.<name> or subagent.<type> when named. */
export function usageTerms(tool, args) {
  const terms = [];
  const t = usageName(tool);
  if (!t) return terms;
  terms.push(`tool.${t}`);
  const skill = t === "skill" ? usageName(args?.name) : null;
  if (skill) terms.push(`skill.${skill}`);
  const sub = t === "task" ? usageName(args?.subagent_type) : null;
  if (sub) terms.push(`subagent.${sub}`);
  return terms;
}

/**
 * Counts tool calls per node and writes them with one `node usage --add` call per flush: on
 * session.idle, or on a call when USAGE_FLUSH_MS has passed since the last write.
 */
export function createUsage({ env = process.env, now = Date.now, run, read } = {}) {
  const counts = new Map();
  const flushedAt = new Map();
  const flush = (sessionID) => {
    const c = counts.get(sessionID);
    if (!c || c.counts.size === 0) return false;
    const home = orchHome(env);
    const dispatch = findDispatch(env, home);
    if (!dispatch) return false;
    const args = [dispatch, "node", "usage", c.at.run, c.at.node];
    for (const [term, n] of c.counts) args.push("--add", `${term}=${n}`);
    counts.delete(sessionID);
    flushedAt.set(sessionID, now());
    run("bash", args);
    return true;
  };
  const count = (sessionID, tool, args) => {
    const at = nodeOf(orchHome(env), sessionID, { env, ...(read ? { read } : {}) });
    if (!at) return false;
    const c = counts.get(sessionID) ?? { at, counts: new Map() };
    for (const term of usageTerms(tool, args)) c.counts.set(term, (c.counts.get(term) ?? 0) + 1);
    counts.set(sessionID, c);
    if (!flushedAt.has(sessionID)) flushedAt.set(sessionID, now());
    if (now() - flushedAt.get(sessionID) >= USAGE_FLUSH_MS) flush(sessionID);
    return true;
  };
  return { count, flush };
}

export function detachedSpawn(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export const OrchNodesPlugin = async () => {
  const handle = createHandler({ run: detachedSpawn });
  const inbox = createInbox();
  const usage = createUsage({ run: detachedSpawn });
  return {
    event: async ({ event }) => {
      try {
        handle(event);
        if (event?.type === "session.idle") usage.flush(event.properties?.sessionID);
      } catch {}
    },
    "tool.execute.before": async (input, output) => {
      try {
        usage.count(input?.sessionID, input?.tool, output?.args);
      } catch {}
    },
    // The model reads the tool result next, so a message appended here reaches the working session.
    "tool.execute.after": async (input, output) => {
      try {
        if (!output || typeof output.output !== "string") return;
        const text = inbox(input?.sessionID);
        if (text) output.output += `\n\n${text}`;
      } catch {}
    },
  };
};

export default {
  id: "orch.nodes",
  server: OrchNodesPlugin,
  setup() {},
};
