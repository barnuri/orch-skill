// Owner liveness, binding and fill. Bun port of lib/runs/owners.sh. A running node names its owner;
// this checks the owner against reality, binds free text to the real opencode session, fills model,
// tokens and cost from that session and moves the node when the owner finished or vanished.
// Reads opencode.db through bun:sqlite (read-only). Every state write goes through mutateRun.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { runLimited } from "../state/proc.ts";
import { orchHome, paths } from "../state/home.ts";
import { epochOf, nowIso } from "../state/clock.ts";
import { loadRun, type RunState } from "../state/store.ts";
import { applyReport, ensureResult, ev, findNode, ownerParse, parseReportArgs, setStatus, SMART_AUTO_TIERS, type Ctx } from "../runs/node.ts";
import { loadEnvFile, nodeSelectionsText } from "./selections.ts";
import { mutateRun, resolveRun } from "./node.ts";

const OWNER_BY = "owner-liveness";
const BINDER = "owner-binder";
const OWNER_TOTAL_SECS_DEFAULT = 5;
const BIND_BEFORE_SECS_DEFAULT = 60;
const BIND_AFTER_SECS_DEFAULT = 180;
const BIND_TIE_SECS = 3;
const UNOWNED_SECS_DEFAULT = 120;
const FILL_MAX_NODES = 5;
const THROTTLE_SECS_DEFAULT = 20;
const STALL_MINUTES_DEFAULT = 15;
const INDEX_DAYS = 3;
const FULL_ID_LEN = 30;
const PREFIX_MIN_LEN = 12;
const JOB_BEFORE_SECS = 5;
const JOB_AFTER_SECS = 300;
const HEARTBEAT_DEBOUNCE_SECS = 20;
const HERDR_PID_WAIT_SECS = 15;
const HUB_HTTP_TIMEOUT_MS = 5000;

export const NODE_VERIFY_OWNERS_USAGE = "dispatch.ts node verify-owners [<run-id>] [--json] [--no-apply]";
export const NODE_BIND_OWNERS_USAGE = "dispatch.ts node bind-owners [--run <run-id>] [--json]";
export const NODE_BRIEF_USAGE = "dispatch.ts node brief <run-id> <node-id>";
export const NODE_ACTIVITY_USAGE = "dispatch.ts node activity <run-id> <node-id> [--limit N]";
export const OWNER_EVENT_USAGE =
  "dispatch.ts owner event <session-id> <started|alive|finished|failed> [--note \"text\"] [--harness opencode|claude]";

type Node = Record<string, any>;
type Op = (run: RunState, ctx: Ctx) => void;
const alt = (v: any, d: any) => (v === null || v === undefined || v === false ? d : v);
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const err = (m: string) => process.stderr.write(m.endsWith("\n") ? m : m + "\n");
const todate = (sec: number) => nowIso(new Date(sec * 1000));
const isoEpoch = (s: unknown): number => {
  const e = typeof s === "string" ? epochOf(s) : null;
  return e ?? 0;
};
const selector = (s: unknown) => /(^|\/|-)smart-auto(-|$)/.test(String(s ?? ""));
const smartAutoSelector = (s: unknown) => /(^|\/)smart-auto(-|$)/.test(String(s ?? ""));

export const ownerSafe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

// owner_registry_write: queues <home>/owners/<id>.json; mutateRun writes it atomically after the state.
export function ownerRegistryWrite(ctx: Ctx, node: string, id: string): void {
  ctx.owners.push({ file: `${ownerSafe(id)}.json`, body: { run: ctx.runId, node, since: ctx.now } });
}

function emit(ctx: Ctx, by: string, kind: string, node: string, from: string, to: string, note: string): void {
  const prev = ctx.by;
  ctx.by = by;
  ev(ctx, kind, node, from, to, note);
  ctx.by = prev;
}

async function commit(home: string, runId: string, ops: Op[]): Promise<boolean> {
  if (ops.length === 0) return true;
  return (await mutateRun(home, runId, (run, ctx) => { for (const op of ops) op(run, ctx); })) === 0;
}

// ---- opencode database ----------------------------------------------------------------------------

export function opencodeDbPath(): string {
  return process.env.ORCH_OPENCODE_DB || join(process.env.HOME || homedir(), ".local/share/opencode/opencode.db");
}

function dbQuery(sql: string, ...params: any[]): any[] | null {
  const p = opencodeDbPath();
  if (!existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true });
    try {
      return db.query(sql).all(...params) as any[];
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export interface Sess {
  id: string;
  parent: string | null;
  title: string;
  model: string | null;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number };
  created: number;
  updated: number;
  busy: boolean;
}

// owner_session_index_file: recent opencode sessions, children (subagents) included. [] when unavailable.
export function sessionIndex(): Sess[] {
  if (process.env.ORCH_OWNER_INDEX === "0") return [];
  const rows = dbQuery(
    `select id, parent_id, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
            tokens_cache_write, time_created, time_updated, time_busy, time_idle
       from session_v2 where time_updated > (strftime('%s','now') - ${INDEX_DAYS} * 86400) * 1000`,
  );
  return (rows ?? []).map((r) => {
    let model: string | null = null;
    try { model = JSON.parse(r.model)?.id ?? null; } catch { model = null; }
    return {
      id: r.id,
      parent: r.parent_id ?? null,
      title: r.title ?? "",
      model,
      cost: r.cost ?? 0,
      tokens: {
        input: r.tokens_input ?? 0, output: r.tokens_output ?? 0, reasoning: r.tokens_reasoning ?? 0,
        cache_read: r.tokens_cache_read ?? 0, cache_write: r.tokens_cache_write ?? 0,
      },
      created: Math.floor((r.time_created ?? 0) / 1000),
      updated: Math.floor((r.time_updated ?? 0) / 1000),
      busy: r.time_busy != null && (r.time_idle == null || r.time_busy > r.time_idle),
    };
  });
}

export interface SessPeak { peak_context: number; steps: number; avg_context: number }

// session_context_peaks: per session, the largest context one assistant step sent (input + cache read + cache write),
// the assistant step count and the mean context. Reads the per-message tokens in session_message. {} when unavailable.
export function sessionPeaks(ids: string[]): Record<string, SessPeak> {
  const want = [...new Set(ids)].filter((i) => /^ses_[A-Za-z0-9]+$/.test(i));
  if (want.length === 0) return {};
  const ctx = `(coalesce(json_extract(data,'$.tokens.input'),0) + coalesce(json_extract(data,'$.tokens.cache.read'),0) + coalesce(json_extract(data,'$.tokens.cache.write'),0))`;
  const rows = dbQuery(
    `select session_id, count(*) as steps, max(${ctx}) as peak, avg(${ctx}) as avg from session_message
      where type = 'assistant' and json_extract(data,'$.tokens') is not null and session_id in (${want.map(() => "?").join(",")})
      group by session_id`, ...want);
  const out: Record<string, SessPeak> = {};
  for (const r of rows ?? []) out[r.session_id] = { peak_context: Math.round(r.peak ?? 0), steps: r.steps ?? 0, avg_context: Math.round(r.avg ?? 0) };
  return out;
}

// opencode_db_session_model: "<provider>/<model>" of the newest assistant message; never a selector.
function dbSessionModel(ses: string): string {
  if (!/^ses_[A-Za-z0-9]+$/.test(ses)) return "";
  const q1 = dbQuery(
    `select coalesce(json_extract(data,'$.model.providerID'), json_extract(data,'$.providerID')) as p,
       coalesce(json_extract(data,'$.model.id'), json_extract(data,'$.modelID')) as m
       from session_message where session_id=? and type='assistant' order by seq desc limit 1`, ses) ?? [];
  const q2 = dbQuery(
    `select coalesce(json_extract(data,'$.model.providerID'), json_extract(data,'$.providerID')) as p,
       coalesce(json_extract(data,'$.model.id'), json_extract(data,'$.modelID')) as m
       from message where session_id=? and json_extract(data,'$.role')='assistant' order by time_created desc limit 1`, ses) ?? [];
  const hit = [...q1, ...q2].find((r) => (r.m ?? "") !== "");
  if (!hit) return "";
  const name = (hit.p ?? "") !== "" ? `${hit.p}/${hit.m}` : String(hit.m);
  return selector(name) ? "" : name;
}

// ---- parsing helpers ------------------------------------------------------------------------------

// owner_literal_id: a session id, claude uuid or pid inside free text.
export function ownerLiteralId(t: string): [string, string] {
  const s = /(ses_[A-Za-z0-9]+)/.exec(t);
  if (s) return ["session", s[1]!];
  const lower = t.toLowerCase();
  const u = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(lower);
  if (u) return ["claude", u[1]!];
  const p = /(^|[^a-z])pid[:\s-]*([0-9]+)/.exec(lower);
  if (p) return ["process", p[2]!];
  return ["none", ""];
}

function throttleOk(home: string, key: string, ttl: number): boolean {
  const f = join(paths.owners(home), "cache", `throttle-${ownerSafe(key)}`);
  let at = 0;
  try { at = Math.floor(statSync(f).mtimeMs / 1000); } catch { at = 0; }
  if (Math.floor(Date.now() / 1000) - at < ttl) return false;
  try {
    mkdirSync(join(paths.owners(home), "cache"), { recursive: true });
    writeFileSync(f, "");
  } catch { /* best effort */ }
  return true;
}
const bindSecs = () => Number(process.env.ORCH_OWNER_BIND_SECS ?? THROTTLE_SECS_DEFAULT);

function takenSessions(home: string): string[] {
  try {
    return readdirSync(paths.owners(home)).filter((f) => /^ses_.*\.json$/.test(f)).map((f) => basename(f, ".json"));
  } catch {
    return [];
  }
}

// ---- probe ----------------------------------------------------------------------------------------

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// job_status (dispatch.ts): "running" | "done exit=N" | "done exit=unknown ..." | null (unknown job).
export function jobStatus(home: string, id: string): string | null {
  const dir = join(paths.jobs(home), id);
  if (!isDir(dir)) return null;
  const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8").trim(); } catch { return null; } };
  const ec = read("exit_code");
  if (ec !== null) return `done exit=${ec}`;
  const pid = read("pid") ?? "";
  if (pid !== "" && alive(Number(pid))) return "running";
  const ec2 = read("exit_code");
  if (ec2 !== null) return `done exit=${ec2}`;
  if (pid === "" && (read("herdr_pane") ?? "") !== "" && existsSync(join(dir, "herdr-launch.sh"))) {
    const launched = Math.floor(statSync(join(dir, "herdr-launch.sh")).mtimeMs / 1000);
    if (Math.floor(Date.now() / 1000) - launched < HERDR_PID_WAIT_SECS) return "running";
  }
  return "done exit=unknown (job process gone without an exit code: killed?)";
}

// owner_session_messages + the session branch of owner_probe: asks the opencode CLI for the newest message.
async function sessionApiProbe(id: string, tmo: number): Promise<[string, string]> {
  const bin = Bun.which("opencode", { PATH: process.env.PATH ?? "" });
  if (!bin) return ["unknown", ""];
  const r = await runLimited(tmo, [bin, "api", "GET", `/api/session/${id}/message`, "--param", "limit=1", "--param", "order=desc"]);
  if (r.code !== 0) return /404|not.?found/i.test(r.out) ? ["gone", ""] : ["unknown", ""];
  let j: any;
  try { j = JSON.parse(r.out); } catch { return ["unknown", ""]; }
  if (!Array.isArray(j.data)) return (j?.status === 404 || /NotFound/i.test(String(j?.error?.name ?? j?.name ?? ""))) ? ["gone", ""] : ["unknown", ""];
  const m = j.data[0];
  if (!m) return ["unknown", ""];
  if (m.type === "assistant" && m.time?.completed != null) {
    const texts: string[] = [];
    const walk = (v: any) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v.type === "text" && typeof v.text === "string") texts.push(v.text); Object.values(v).forEach(walk); } };
    walk(m);
    return ["finished", texts.join(" ").replace(/[\r\n\t]+/g, " ").slice(0, 300)];
  }
  return ["alive", ""];
}

// owner_state: owner_probe cached for ORCH_OWNER_CACHE_SECS (default 20) per kind-id.
async function ownerStateCached(home: string, kind: string, id: string, dl: number): Promise<[string, string]> {
  const cache = join(paths.owners(home), "cache", `${ownerSafe(`${kind}-${id}`)}.json`);
  const now = Math.floor(Date.now() / 1000);
  const ttl = /^[0-9]+$/.test(process.env.ORCH_OWNER_CACHE_SECS ?? "") ? Number(process.env.ORCH_OWNER_CACHE_SECS) : 20;
  try {
    const c = JSON.parse(readFileSync(cache, "utf8"));
    if (now - (Number(c.at) || 0) < ttl) return [String(c.state), String(c.note ?? "")];
  } catch {}
  const left = dl - now;
  if (left < 1) return ["unknown", ""];
  const callT = /^[0-9]+$/.test(process.env.ORCH_OWNER_CALL_TIMEOUT ?? "") && Number(process.env.ORCH_OWNER_CALL_TIMEOUT) > 0 ? Number(process.env.ORCH_OWNER_CALL_TIMEOUT) : 3;
  const res = await ownerProbe(home, kind, id, Math.min(callT, left));
  if (res[0] !== "unknown") {
    try {
      mkdirSync(join(cache, ".."), { recursive: true });
      writeFileSync(`${cache}.tmp.${process.pid}`, JSON.stringify({ at: Math.floor(Date.now() / 1000), state: res[0], note: res[1] }) + "\n");
      renameSync(`${cache}.tmp.${process.pid}`, cache);
    } catch {}
  }
  return res;
}

// owner_children_cands: opencode's children of a session through the CLI; null when unreachable.
async function childrenViaApi(parent: string): Promise<Cand[] | null> {
  const bin = Bun.which("opencode", { PATH: process.env.PATH ?? "" });
  if (!bin) return null;
  const t = Number(process.env.ORCH_OWNER_CALL_TIMEOUT);
  const r = await runLimited(t > 0 ? t : 3, [bin, "api", "GET", "/api/session", "--param", `parentID=${parent}`, "--param", "limit=100"]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out);
    return (Array.isArray(j.data) ? j.data : []).filter((x: any) => x.parentID === parent && (x.id ?? "") !== "")
      .map((x: any) => ({ child: x.id, title: x.title ?? "", created: (x.time?.created ?? 0) / 1000 }));
  } catch { return null; }
}

// owner_probe: [state, note]; state alive | finished | gone | unknown.
export async function ownerProbe(home: string, kind: string, id: string, tmo = 3): Promise<[string, string]> {
  if (kind === "process") return [alive(Number(id)) ? "alive" : "gone", ""];
  if (kind === "job") {
    const st = jobStatus(home, id);
    if (st === null) return ["gone", ""];
    if (st === "running") return ["alive", ""];
    if (st.startsWith("done exit=0")) return ["finished", `job ${id} exited 0`];
    if (st.startsWith("done")) return ["gone", `job ${id} exited ${st.slice(5)}`];
    return ["unknown", ""];
  }
  if (kind === "session") {
    const rows = dbQuery("select time_busy, time_idle from session_v2 where id = ?", id);
    if (rows === null) return sessionApiProbe(id, tmo);
    if (rows.length === 0) return ["gone", ""];
    const r = rows[0];
    return r.time_busy != null && (r.time_idle == null || r.time_busy > r.time_idle) ? ["alive", ""] : ["finished", ""];
  }
  return ["unknown", ""];
}

// ---- state transitions ---------------------------------------------------------------------------

function patch(run: RunState, node: string, f: (n: Node) => void): void {
  const n = findNode(run, node);
  if (n) f(n);
}

// owner_apply_state: the one set of transition rules, shared by verify-owners and `owner event`.
export function applyOwnerState(run: RunState, ctx: Ctx, node: string, state: string, note: string, id: string, by: string, now: string): void {
  const n = findNode(run, node);
  if (!n) return;
  switch (state) {
    case "finished":
    case "idle": {
      if (state === "idle" || !isDir(join(paths.jobs(ctx.home), id))) {
        n.owner_state = "idle";
        n.owner_checked = now;
        n.owner_idle_since = n.owner_idle_since ?? now;
        if (note !== "") n.owner_note = note;
        return;
      }
      ctx.by = by;
      setStatus(run, node, "done", "", "", "", "", ctx);
      n.auto = true;
      n.unverified = true;
      ensureResult(run, node, ctx);
      n.owner_state = "finished";
      n.owner_checked = now;
      n.report = { ...(n.report ?? {}), reported_by: by, note: note === "" ? "owner finished (no final message)" : note, at: now };
      return;
    }
    case "gone":
    case "failed":
      ctx.by = by;
      setStatus(run, node, "error", "", note || `owner ${id} is gone`, "", "", ctx);
      n.owner_state = "gone";
      n.owner_checked = now;
      return;
    case "alive":
      n.updated = now;
      n.owner_state = "alive";
      n.owner_checked = now;
      n.owner_idle_since = null;
      if (n.stalled === true) { n.stalled = null; n.stalled_reason = null; }
      return;
    default:
      n.owner_state = "unknown";
      n.owner_checked = now;
  }
}

// ---- binder ---------------------------------------------------------------------------------------

interface Cand { child: string; title: string; created: number }
interface MatchNode { id: string; text: string; start: number }
interface Match { child?: string; how?: string; reason?: string }

const STOP = ["the", "and", "for", "with", "from", "that", "this", "node", "agent", "task", "run", "spawned", "ses"];
const toks = (s: string): string[] => [...new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.includes(w)))];
const scoreOf = (title: string, text: string): number => {
  const x = new Set(toks(text));
  return toks(title).filter((w) => x.has(w)).length;
};

// owner_bind_match: never guesses on a tie. needTitle also refuses a time-only match.
export function ownerBindMatch(nodes: MatchNode[], id: string, cands: Cand[], needTitle: boolean): Match {
  const before = Number(process.env.ORCH_BIND_BEFORE_SECS ?? BIND_BEFORE_SECS_DEFAULT);
  const after = Number(process.env.ORCH_BIND_AFTER_SECS ?? BIND_AFTER_SECS_DEFAULT);
  const n = nodes.find((x) => x.id === id);
  if (!n) return { reason: "no child session found near the node start" };
  const others = nodes.filter((x) => x.id !== id);
  const e = cands
    .map((c) => ({ c, d: c.created - n.start }))
    .filter(({ d }) => d >= -before && d <= after)
    .map(({ c, d }) => ({
      child: c.child, created: c.created, ad: Math.abs(d), s: scoreOf(c.title, n.text),
      os: Math.max(0, ...others.map((o) => scoreOf(c.title, o.text))),
    }))
    .filter((x) => x.s >= x.os);
  if (e.length === 0) return { reason: "no child session found near the node start" };
  const top = Math.max(...e.map((x) => x.s));
  if (top > 0) {
    const t = e.filter((x) => x.s === top);
    return t.length === 1 ? { child: t[0]!.child, how: "title" } : { reason: `tie on title between ${t.map((x) => x.child).join(", ")}` };
  }
  if (needTitle) return { reason: "no session title near the node start shares a word with it" };
  const s = [...e].sort((a, b) => a.ad - b.ad);
  if (s.length > 1 && s[1]!.ad - s[0]!.ad < BIND_TIE_SECS) return { reason: `tie on time between ${s.map((x) => x.child).join(", ")}` };
  const clash = others.filter((o) => Math.abs(s[0]!.created - o.start) <= s[0]!.ad + BIND_TIE_SECS);
  if (clash.length > 0) return { reason: `candidate ${s[0]!.child} also fits node ${clash.map((o) => o.id).join(", ")}` };
  return { child: s[0]!.child, how: "time" };
}

function pendingCands(home: string, parent: string): Cand[] {
  const dir = join(paths.owners(home), "pending");
  const out: Cand[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return out; }
  const now = Date.now() / 1000;
  for (const f of files) {
    try {
      if (now - statSync(join(dir, f)).mtimeMs / 1000 >= 86400) continue;
      if (existsSync(join(paths.owners(home), f))) continue;
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (j.parent !== parent || (j.child ?? "") === "") continue;
      const created = j.created_ms != null ? j.created_ms / 1000 : (epochOf(String(j.created ?? "")) ?? 0);
      out.push({ child: j.child, title: j.title ?? "", created });
    } catch { /* skip */ }
  }
  return out;
}

export function bindApply(run: RunState, ctx: Ctx, node: string, kind: string, id: string, how: string): void {
  const n = findNode(run, node);
  if (!n) return;
  n.owner_kind = kind;
  n.owner_id = id;
  n.owner_bind = how;
  n.owner_reason = null;
  n.unowned = null;
  if (n.owner_state === "unbound") n.owner_state = null;
  if ((n.owner ?? "") === "") n.owner = `agent ${id}`;
  ownerRegistryWrite(ctx, node, id);
  emit(ctx, BINDER, "owner", node, "", "bound", `owner ${id} bound (${how})`);
}

function markUnbound(run: RunState, ctx: Ctx, node: string, reason: string): void {
  const n = findNode(run, node);
  if (!n || n.owner_reason === reason) return;
  n.owner_state = "unbound";
  n.owner_reason = reason;
  n.owner_checked = ctx.now;
  if (n.owner_kind == null || n.owner_kind === "unknown") n.owner_kind = "unbound";
  emit(ctx, BINDER, "owner", node, "", "unbound", reason);
}

const running = (run: RunState): Node[] => run.nodes.filter((n) => n.status === "running");

// A running node whose owner text names other nodes of the run is an umbrella.
async function umbrellaRun(home: string, runId: string): Promise<string[]> {
  const run = await loadRun(home, runId);
  if (!run) return [];
  const ids = run.nodes.map((n) => n.id);
  const ops: Op[] = [];
  const lines: string[] = [];
  for (const n of running(run)) {
    if ((n.job_id ?? "") !== "" || ["session", "process", "job"].includes(n.owner_kind ?? "")) continue;
    const words = String(n.owner ?? "").split(/[^A-Za-z0-9_.-]+/).filter((w) => w !== "");
    const kids = [...new Set(words.filter((w) => w !== n.id && ids.includes(w)))].sort();
    if (kids.length === 0) continue;
    const kn = run.nodes.filter((x) => kids.includes(x.id));
    const models = [...new Set(kn.map((x) => x.model || x.report?.model || "").filter((m) => m !== ""))];
    const model = models.length === 1 ? models[0] : models.length > 1 ? "mixed" : "";
    const sum = `${kn.filter((x) => x.status === "done").length}/${kn.length} done`;
    const same = JSON.stringify(n.umbrella) === JSON.stringify(kids);
    const modelDiff = model !== "" && (n.model ?? "") !== model && ((n.model ?? "") === "" || n.umbrella_model === true);
    if (same && n.umbrella_status === sum && n.owner_kind === "umbrella" && !modelDiff) continue;
    const id = n.id;
    ops.push((r, ctx) => patch(r, id, (x) => {
      x.umbrella = kids;
      x.umbrella_status = sum;
      x.owner_kind = "umbrella";
      x.owner_id = null;
      x.owner_state = "umbrella";
      x.owner_reason = `umbrella over ${kids.join(", ")}`;
      x.unowned = null;
      if (model !== "" && ((x.model ?? "") === "" || x.umbrella_model === true)) { x.model = model; x.umbrella_model = true; }
      emit(ctx, BINDER, "owner", id, "", "umbrella", `umbrella over ${kids.join(",")} (${sum})`);
    }));
    lines.push(`${id}\tumbrella over ${kids.join(",")}`);
  }
  return (await commit(home, runId, ops)) ? lines : [];
}

// Links each dispatched job (owner_kind "job") to the opencode session it started.
async function jobBindRun(home: string, runId: string): Promise<string[]> {
  const run = await loadRun(home, runId);
  if (!run || process.env.ORCH_OWNER_BIND === "0") return [];
  const nodes = run.nodes
    .filter((n) => (n.job_id ?? "") !== "" && ["running", "done", "error"].includes(n.status) && (n.owner_bind ?? "") !== "job" && alt(n.owner_kind, "job") === "job")
    .map((n) => {
      const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(String(n.job_id).slice(0, 14));
      const start = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000 : null;
      return { id: n.id as string, start, prompt: String(n.prompt ?? "") };
    })
    .filter((n): n is { id: string; start: number; prompt: string } => n.start !== null);
  if (nodes.length === 0) return [];
  const lo = (Math.min(...nodes.map((n) => n.start)) - JOB_BEFORE_SECS) * 1000;
  const hi = (Math.max(...nodes.map((n) => n.start)) + JOB_AFTER_SECS) * 1000;
  const sessions = dbQuery(
    `select s.id, s.time_created,
      (select json_extract(m.data, '$.text') from session_message m where m.session_id = s.id and m.type = 'user' order by m.seq limit 1) as first
      from session_v2 s where s.parent_id is null and s.time_created between ? and ?`, lo, hi);
  if (!sessions || sessions.length === 0) return [];
  const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const same = (p: string, t: string) => p.length > 0 && t.length > 0 && (t.startsWith(p) || p.startsWith(t));
  const taken = new Set(run.nodes.map((n) => n.owner_id).filter((i: any) => typeof i === "string" && i.startsWith("ses_")));
  const ops: Op[] = [];
  const lines: string[] = [];
  for (const n of nodes) {
    const p = norm(n.prompt);
    const c = sessions
      .filter((s) => !taken.has(s.id))
      .map((s) => ({ id: s.id as string, d: s.time_created / 1000 - n.start, m: same(p, norm(s.first)) }))
      .filter((x) => x.d >= -JOB_BEFORE_SECS && x.d <= JOB_AFTER_SECS)
      .map((x) => ({ ...x, ad: Math.abs(x.d) }));
    const pm = c.filter((x) => x.m).sort((a, b) => a.ad - b.ad);
    const pick = pm.length > 0 ? { id: pm[0]!.id, how: "job-prompt" } : c.length === 1 ? { id: c[0]!.id, how: "job-time" } : null;
    if (!pick) continue;
    taken.add(pick.id);
    const node = n.id;
    ops.push((r, ctx) => patch(r, node, (x) => {
      x.owner_kind = "session";
      x.owner_id = pick.id;
      x.owner_bind = "job";
      x.owner_reason = null;
      x.unowned = null;
      if (x.status === "running") ownerRegistryWrite(ctx, node, pick.id);
      emit(ctx, BINDER, "owner", node, "", "bound", `owner ${pick.id} bound (${pick.how})`);
    }));
    lines.push(`${node}\tbound ${pick.id} (${pick.how})`);
  }
  return (await commit(home, runId, ops)) ? lines : [];
}

// A session id shorter than a full one is a prefix: bind the one session it names.
async function prefixRun(home: string, runId: string, ix: Sess[]): Promise<string[]> {
  const run = await loadRun(home, runId);
  if (!run) return [];
  const ops: Op[] = [];
  const lines: string[] = [];
  for (const n of running(run)) {
    if ((n.job_id ?? "") !== "" || n.owner_kind === "umbrella") continue;
    const oid = /^ses_[A-Za-z0-9]+$/.test(String(n.owner_id ?? "")) ? String(n.owner_id) : "";
    const p = oid !== "" ? oid : (/(ses_[A-Za-z0-9]+)/.exec(String(n.owner ?? ""))?.[1] ?? "");
    if (p.length < PREFIX_MIN_LEN || p.length >= FULL_ID_LEN) continue;
    const m = ix.map((s) => s.id).filter((id) => id.startsWith(p));
    if (m.length === 0 || (m.length === 1 && m[0] === p)) continue;
    if (!(m.length > 1 || n.owner_bind !== "prefix" || n.owner_id !== m[0])) continue;
    const node = n.id;
    if (m.length > 1) {
      const reason = `session id prefix ${p} is ambiguous: ${m.join(", ")}`;
      if (n.owner_reason !== reason) {
        ops.push((r, ctx) => patch(r, node, (x) => {
          x.owner_kind = "unbound";
          x.owner_state = "unbound";
          x.owner_reason = reason;
          x.owner_checked = ctx.now;
          emit(ctx, BINDER, "owner", node, "", "unbound", `session id prefix ${p} is ambiguous`);
        }));
      }
      lines.push(`${node}\tunbound: prefix ${p} is ambiguous`);
    } else {
      ops.push((r, ctx) => bindApply(r, ctx, node, "session", m[0]!, "prefix"));
      lines.push(`${node}\tbound ${m[0]} (prefix)`);
    }
  }
  return (await commit(home, runId, ops)) ? lines : [];
}

// owners_bind_run: "<node>\t<result>" per node it looked at.
export async function ownersBindRun(home: string, runId: string): Promise<string[]> {
  if (process.env.ORCH_OWNER_BIND === "0") return [];
  const out: string[] = [];
  let run = await loadRun(home, runId);
  if (!run) return out;
  out.push(...(await umbrellaRun(home, runId)));
  out.push(...(await jobBindRun(home, runId)));
  run = (await loadRun(home, runId))!;
  const need: string[] = [];
  const literalOps: Op[] = [];
  for (const n of running(run)) {
    if ((n.job_id ?? "") !== "" || n.owner === "coordinator" || n.owner_kind === "umbrella") continue;
    const owner = String(n.owner ?? "").replace(/[\t\r\n]/g, " ");
    const kindNow = n.owner_kind ?? "";
    const oid = (n.owner_id ?? "") === "" || ["unbound", "unknown"].includes(kindNow) ? "" : String(n.owner_id);
    if (oid !== "" && existsSync(join(paths.owners(home), `${ownerSafe(oid)}.json`))) continue;
    const [kind] = ownerParse(owner, paths.jobs(home));
    if (kind === "job") continue;
    if (owner !== "") {
      const [lk, li] = ownerLiteralId(owner);
      if (lk !== "none") {
        const node = n.id;
        literalOps.push((r, ctx) => bindApply(r, ctx, node, lk, li, "literal"));
        out.push(`${node}\tbound (literal)`);
        continue;
      }
    }
    need.push(n.id);
  }
  await commit(home, runId, literalOps);
  const ix = sessionIndex();
  out.push(...(await prefixRun(home, runId, ix)));
  if (need.length === 0) return out;

  run = (await loadRun(home, runId))!;
  const parent = String(run.harness_session ?? "");
  let nodesJson: MatchNode[] = run.nodes.filter((n) => need.includes(n.id)).map((n) => ({
    id: n.id,
    text: [n.label, n.id, n.owner ?? "", n.report?.note ?? "", (n.notes ?? []).map((x: any) => x.text).join(" ")].map((x) => x ?? "").join(" "),
    start: isoEpoch(n.started ?? n.updated ?? n.created),
  }));
  let pend: Cand[] = parent ? pendingCands(home, parent) : [];
  const pendN = pend.length;
  const taken = takenSessions(home);
  let kids: Cand[] | null = null;
  let kidsOk = true;
  let idx: Cand[] | null = null;
  const ops: Op[] = [];
  for (const node of need) {
    if (!throttleOk(home, `bind-${runId}-${node}`, bindSecs())) continue;
    let m = ownerBindMatch(nodesJson, node, pend, false);
    let child = m.child ?? "";
    let how = m.how ?? "";
    let why = m.reason ?? "";
    if (child === "" && pendN === 0 && parent.startsWith("ses_")) {
      if (kids === null) {
        if (ix.length > 0) kids = ix.filter((s) => s.parent === parent && !taken.includes(s.id)).map((s) => ({ child: s.id, title: s.title, created: s.created }));
        else {
          const l = await childrenViaApi(parent);
          kidsOk = l !== null;
          kids = (l ?? []).filter((c) => !taken.includes(c.child));
        }
      }
      m = ownerBindMatch(nodesJson, node, kids, false);
      child = m.child ?? "";
      how = m.how ? `listing-${m.how}` : "";
      why = m.reason ?? "";
      if (!kidsOk) why = "opencode session listing unavailable";
    } else if (child === "" && !parent.startsWith("ses_")) {
      why = `${why ? why + "; " : ""}run harness session '${parent || "none"}' is not an opencode session`;
    }
    if (child === "" && ix.length > 0) {
      if (idx === null) {
        const t = new Set([...run.nodes.map((n) => n.owner_id).filter(Boolean), ...taken]);
        idx = ix.filter((s) => s.parent != null && !t.has(s.id)).map((s) => ({ child: s.id, title: s.title, created: s.created }));
      }
      const m2 = ownerBindMatch(nodesJson, node, idx, true);
      if (m2.child) { child = m2.child; how = `index-${m2.how}`; }
      else why = `${why ? why + "; " : ""}session table: ${m2.reason || "nothing found"}`;
    }
    if (child !== "") {
      const c = child;
      const h = how || "time";
      ops.push((r, ctx) => bindApply(r, ctx, node, "session", c, h));
      pend = pend.filter((x) => x.child !== c);
      if (kids) kids = kids.filter((x) => x.child !== c);
      if (idx) idx = idx.filter((x) => x.child !== c);
      nodesJson = nodesJson.filter((x) => x.id !== node);
      out.push(`${node}\tbound ${c} (${how})`);
      continue;
    }
    const n = findNode(run, node)!;
    const owner = String(n.owner ?? "");
    const age = Math.floor(Date.now() / 1000) - isoEpoch(n.started);
    if (owner === "" && age >= Number(process.env.ORCH_UNOWNED_SECS ?? UNOWNED_SECS_DEFAULT)) {
      if (n.unowned !== true) {
        const reason = `running without an owner for ${Math.floor(age / 60)} min; ${why || "no session found"}`;
        ops.push((r, ctx) => patch(r, node, (x) => {
          x.unowned = true;
          x.owner_state = "unbound";
          x.owner_reason = reason;
          emit(ctx, BINDER, "owner", node, "", "unowned", "running without an owner");
        }));
      }
      out.push(`${node}\tunowned`);
    } else if (owner !== "") {
      const reason = `owner "${owner}" names no session id; ${why || "no session found"}`;
      ops.push((r, ctx) => markUnbound(r, ctx, node, reason));
      out.push(`${node}\tunbound: ${why}`);
    }
  }
  await commit(home, runId, ops);
  return out;
}

// ---- fill: session figures onto the node, plus the stall rules ------------------------------------

const arrCmp = (a: [string, number], b: [string, number]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);

function fillNodes(run: RunState, ix: Sess[], nowEpoch: number, stall: number, nowIsoText: string, peaks: Record<string, SessPeak> = {}): void {
  const by = new Map(ix.map((s) => [s.id, s]));
  const all: Node[] = structuredClone(run.nodes);
  const machineReport = (n: Node): boolean => {
    if (n.report == null) return true;
    if (["owner-fill", OWNER_BY].includes(n.report.reported_by ?? "")) return true;
    const auto: string[] = n.report.auto ?? [];
    return !Object.entries(n.report).some(([k, v]) => ["input_tokens", "output_tokens", "cache_read_tokens", "usd"].includes(k) && v != null && !auto.includes(k));
  };
  const boundTo = (n: Node, id: string) =>
    (n.owner_id ?? "") === id && alt(n.owner_kind, "session") === "session" ||
    ((n.session ?? "") === id && (n.job_id ?? "") === "") || n.session_stats?.session === id;
  const share = (n: Node, s: Sess) => {
    const ns = n.started ?? "";
    const ni = Math.max(0, all.findIndex((v) => v.id === n.id));
    const co = all.filter((v, i) =>
      v.id !== n.id && ["running", "done", "error"].includes(v.status) && boundTo(v, s.id) &&
      arrCmp([v.started ?? "", i], [ns, ni]) < 0 &&
      !((v.finished ?? "") !== "" && ns !== "" && v.finished <= ns));
    const fromStats = [
      ...all.filter((v) => v.id !== n.id && ["done", "error", "skipped"].includes(v.status) && v.session_stats?.session === s.id &&
        (v.finished ?? "") !== "" && ((n.started ?? "") === "" || v.finished <= n.started)),
      ...co.filter((v) => v.session_stats?.final === true),
    ].map((v) => {
      const st = v.session_stats;
      return { usd: st.cost ?? 0, input: st.tokens?.input ?? 0, output: st.tokens?.output ?? 0, reasoning: st.tokens?.reasoning ?? 0, cache_read: st.tokens?.cache_read ?? 0, cache_write: st.tokens?.cache_write ?? 0 };
    });
    const fromAttempts = (n.attempts ?? []).filter((a: any) => a.session === s.id && a.cost?.cost_basis === "opencode-session").map((a: any) => {
      const c = a.cost;
      return { usd: c.usd ?? 0, input: c.input_tokens ?? 0, output: c.output_tokens ?? 0, reasoning: 0, cache_read: c.cache_read_tokens ?? 0, cache_write: c.cache_creation_tokens ?? 0 };
    });
    const prior = [...fromStats, ...fromAttempts];
    const behind = co.some((v) => v.session_stats?.final !== true);
    const sum = (k: keyof (typeof prior)[number]) => prior.reduce((a, p) => a + p[k], 0);
    const left = (k: keyof (typeof prior)[number], v: number) => (behind ? 0 : Math.max(v - sum(k), 0));
    return {
      base: { cost: sum("usd"), tokens: { input: sum("input"), output: sum("output"), reasoning: sum("reasoning"), cache_read: sum("cache_read"), cache_write: sum("cache_write") } },
      cost: left("usd", s.cost),
      tokens: {
        input: left("input", s.tokens.input), output: left("output", s.tokens.output), reasoning: left("reasoning", s.tokens.reasoning),
        cache_read: left("cache_read", s.tokens.cache_read), cache_write: left("cache_write", s.tokens.cache_write),
      },
    };
  };
  const sessionCost = (s: Sess, sh: ReturnType<typeof share>) => ({
    usd: sh.cost, cost_basis: "opencode-session",
    input_tokens: sh.tokens.input, output_tokens: sh.tokens.output,
    cache_read_tokens: sh.tokens.cache_read, cache_creation_tokens: sh.tokens.cache_write,
    models: s.model == null ? [] : [{
      model: s.model, usd: sh.cost, input_tokens: sh.tokens.input, output_tokens: sh.tokens.output,
      cache_read_tokens: sh.tokens.cache_read, cache_creation_tokens: sh.tokens.cache_write,
    }],
  });
  const fill = (n: Node, s: Sess, final: boolean) => {
    if ((n.session ?? "") === "") n.session = s.id;
    if ((n.harness ?? "") === "") n.harness = "opencode";
    if ((n.model ?? "") === "" && s.model != null) n.model = s.model;
    if ((n.model_id ?? "") === "" && s.model != null) n.model_id = s.model;
    if (s.model != null && !smartAutoSelector(s.model) && n.actual_model !== s.model) n.actual_model = s.model;
    if (n.started == null) n.started = todate(s.created);
    const t = /(^|\/)smart-auto-([a-z]+)$/.exec(String(n.model ?? ""));
    if (n.tier == null && t) n.tier = t[2];
    const sh = share(n, s);
    n.session_stats = {
      session: s.id, cost: sh.cost, tokens: sh.tokens, baseline: sh.base,
      session_total: { cost: s.cost, tokens: s.tokens }, created: todate(s.created), updated: todate(s.updated),
      duration_s: s.updated - s.created, busy: s.busy, ...(final ? { final: true } : {}),
      ...(peaks[s.id] ?? {}),
    };
    if (((n.job_id ?? "") === "" || n.owner_bind === "job") && (n.cost == null || n.cost.cost_basis === "opencode-session")) {
      if (machineReport(n)) n.cost = sessionCost(s, sh);
      else if (n.cost != null) n.cost = null;
    }
    const v: Record<string, number> = { input_tokens: sh.tokens.input, output_tokens: sh.tokens.output, cache_read_tokens: sh.tokens.cache_read, usd: sh.cost };
    if (n.report == null || n.report.reported_by === "owner-fill") {
      n.report = { reported_by: "owner-fill", model: s.model, note: null, at: n.report?.at ?? nowIsoText, ...v };
    } else {
      for (const k of Object.keys(v).sort()) {
        if (n.report[k] == null || (n.report.auto ?? []).includes(k)) {
          n.report[k] = v[k];
          n.report.auto = [...new Set([...(n.report.auto ?? []), k])].sort();
        }
      }
    }
  };
  const boundSession = (n: Node): string | null => {
    if (String(n.owner_id ?? "").startsWith("ses_") && alt(n.owner_kind, "session") === "session") return n.owner_id;
    if (String(n.session ?? "").startsWith("ses_") && (n.job_id ?? "") === "") return n.session;
    return null;
  };
  const stalls = (n: Node, since: string, reason: string, active: boolean) => {
    if (active) { n.stalled = true; n.stalled_reason = reason; } else if (n.stalled != null) { n.stalled = null; n.stalled_reason = null; }
    void since;
  };
  for (const n of run.nodes) {
    if (["done", "error", "skipped"].includes(n.status)) {
      const b = boundSession(n);
      if (((n.job_id ?? "") === "" || n.owner_bind === "job") && (n.session_stats?.final ?? false) !== true && b !== null && by.get(b)) {
        fill(n, by.get(b)!, true);
        n.stalled = null;
        n.stalled_reason = null;
      } else if (n.session_stats && n.session_stats.peak_context == null && peaks[n.session_stats.session]) {
        Object.assign(n.session_stats, peaks[n.session_stats.session]);
      }
    } else if (n.status !== "running") {
      continue;
    } else if (n.owner_kind === "session" && (n.owner_id ?? "") !== "" && by.get(n.owner_id)) {
      const s = by.get(n.owner_id)!;
      const upd = todate(s.updated);
      fill(n, s, false);
      if (upd > (n.last_activity ?? "")) n.last_activity = upd;
      if ((n.seg_open ?? false) && n.started_at == null && n.dispatched_at != null) {
        const c = todate(s.created);
        if (c >= n.dispatched_at) n.started_at = c;
        else if (upd >= n.dispatched_at) n.started_at = upd;
      }
      if (n.owner_bind === "job") continue;
      stalls(n, "", `no activity since ${upd}`, nowEpoch - s.updated >= stall && !s.busy);
    } else if (n.owner_state === "idle" && (n.owner_idle_since ?? "") !== "") {
      const since = isoEpoch(n.owner_idle_since) || nowEpoch;
      stalls(n, "", `idle since ${n.owner_idle_since}`, nowEpoch - since >= stall);
    } else if (n.stalled != null && n.owner_state === "alive") {
      n.stalled = null;
      n.stalled_reason = null;
    }
  }
}

async function stallSecs(home: string): Promise<number> {
  const env = process.env.ORCH_STALL_MINUTES;
  if (env && /^[0-9]+$/.test(env)) return Number(env) * 60;
  const raw = await Bun.file(paths.profiles(home)).json().then((p: any) => p?.settings?.stall_minutes).catch(() => undefined);
  const m = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : typeof raw === "string" && /^[0-9]+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : STALL_MINUTES_DEFAULT;
  return m * 60;
}

// owners_fill_index_run: applies the fill rules (writes only on change), one event per node that newly
// stalls, and returns "<node>\tstalled: <reason>" for every stalled running node.
export async function ownersFillIndexRun(home: string, runId: string, ixIn?: Sess[]): Promise<string[]> {
  const run = await loadRun(home, runId);
  if (!run) return [];
  const ix = ixIn ?? sessionIndex();
  const stall = await stallSecs(home);
  const nowEpoch = Math.floor(Date.now() / 1000);
  const peaks = sessionPeaks(run.nodes.flatMap((n) => [n.owner_id, n.session, n.session_stats?.session].filter((x): x is string => typeof x === "string")));
  const apply = (r: RunState, at: string) => fillNodes(r, ix, nowEpoch, stall, at, peaks);
  const next = structuredClone(run);
  apply(next, nowIso());
  const newly: string[] = [];
  const lines: string[] = [];
  for (const n of next.nodes.filter((x) => x.status === "running" && x.stalled === true)) {
    const was = run.nodes.find((o) => o.id === n.id)?.stalled === true;
    if (!was) newly.push(n.id);
    lines.push(`${n.id}\tstalled: ${n.stalled_reason}`);
  }
  if (JSON.stringify(next) !== JSON.stringify(run)) {
    const ok = await mutateRun(home, runId, (r, ctx) => {
      apply(r, ctx.now);
      for (const id of newly) emit(ctx, OWNER_BY, "owner", id, "", "stalled", String(findNode(r, id)?.stalled_reason ?? ""));
    });
    if (ok !== 0) return [];
  }
  return lines;
}

// ---- actual model, selections ---------------------------------------------------------------------

async function hubGet(home: string, path: string): Promise<any | null> {
  await loadEnvFile(home);
  const url = process.env.LLM_HUB_URL ?? "";
  if (url === "") return null;
  const key = process.env.LLM_HUB_KEY ?? "";
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
      headers: key === "" ? {} : { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HUB_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// copilot_actual_model: the model that served the latest main-agent call, from events.jsonl.
export function copilotActualModel(sid: string): string {
  const dir = process.env.ORCH_COPILOT_SESSION_DIR || join(process.env.COPILOT_HOME || join(process.env.HOME || homedir(), ".copilot"), "session-state");
  let text = "";
  try { text = readFileSync(join(dir, sid, "events.jsonl"), "utf8"); } catch { return ""; }
  let model = "";
  for (const line of text.split("\n")) {
    if (!line.includes("session.usage_record")) continue;
    try {
      const j = JSON.parse(line);
      if (j.type !== "session.usage_record") continue;
      const u = j.data?.usage;
      if (!u || (u.initiator ?? "") === "sub-agent") continue;
      const m = u.responseModel ?? u.model ?? "";
      if (m !== "" && m !== "auto" && !smartAutoSelector(m)) model = m;
    } catch { /* skip */ }
  }
  return model;
}

async function actualRun(home: string, runId: string, ix: Sess[], deadline: number): Promise<void> {
  const run = await loadRun(home, runId);
  if (!run) return;
  if (run.nodes.some((n) => n.hub?.actual?.model != null && ((n.actual_model ?? "") === "" || n.role == null || n.tier == null))) {
    await commit(home, runId, [(r) => {
      for (const n of r.nodes) {
        const a = n.hub?.actual;
        if (a?.model == null) continue;
        if ((n.actual_model ?? "") === "") n.actual_model = a.model;
        if (n.role == null && a.role != null) n.role = a.role;
        if (n.tier == null && a.tier != null) n.tier = a.tier;
      }
    }]);
  }
  const fresh = (await loadRun(home, runId)) ?? run;
  const models = new Map(ix.map((s) => [s.id, s.model]));
  let count = 0;
  for (const n of fresh.nodes) {
    if (!(n.status === "running" || ((n.actual_model ?? "") === "" && ["done", "error"].includes(n.status) && n.fill_backfilled !== true))) continue;
    const ses = String(n.owner_id ?? "").startsWith("ses_") && alt(n.owner_kind, "session") === "session" ? n.owner_id : String(n.session ?? "").startsWith("ses_") ? n.session : "";
    let kind = "";
    if ((n.adapter || n.harness || "") === "copilot" && (n.session ?? "") !== "") kind = "copilot";
    else if ((ses !== "" || (n.worker_identity ?? "") !== "") && (selector(models.get(ses)) || selector(n.model_id) || selector(n.model))) kind = "hub";
    if (kind === "") continue;
    if (Date.now() / 1000 >= deadline) break;
    let sel: { model: string; role: any; tier: any } | null = null;
    if (kind === "copilot") {
      const m = copilotActualModel(n.session);
      if (m !== "") sel = { model: m, role: null, tier: null };
    } else {
      if (count >= FILL_MAX_NODES) continue;
      if (!throttleOk(home, `actual-${runId}-${n.id}`, bindSecs())) continue;
      count++;
      if (process.env.ORCH_OWNER_HUB !== "0") {
        const w = (n.worker_identity ?? "") !== "" ? await hubGet(home, `/api/smart-auto/current?worker=${encodeURIComponent(n.worker_identity)}`) : null;
        const main = w?.selection?.main;
        if (main?.model != null) sel = { model: main.model, role: main.role ?? null, tier: main.tier ?? null };
        else if (ses !== "") {
          const j = await hubGet(home, `/api/smart-auto/current?session=${encodeURIComponent(ses)}`);
          const m = j?.selection?.main?.model;
          if (m) sel = { model: m, role: null, tier: null };
        }
      }
      if (!sel && ses !== "") {
        const m = dbSessionModel(ses);
        if (m !== "") sel = { model: m, role: null, tier: null };
      }
    }
    if (!sel) continue;
    const s = sel;
    if (!(n.actual_model !== s.model || (n.role == null && s.role != null) || (n.tier == null && s.tier != null))) continue;
    const id = n.id;
    await commit(home, runId, [(r) => patch(r, id, (x) => {
      x.actual_model = s.model;
      if (x.role == null && s.role != null) x.role = s.role;
      if (x.tier == null && s.tier != null) x.tier = s.tier;
    })]);
  }
}

async function selectionsRun(home: string, runId: string, deadline: number): Promise<void> {
  if (process.env.ORCH_OWNER_HUB === "0") return;
  const run = await loadRun(home, runId);
  if (!run) return;
  await loadEnvFile(home);
  if ((process.env.LLM_HUB_URL ?? "") === "") return;
  let n = 0;
  for (const node of run.nodes) {
    if ((node.worker_identity ?? "") === "") continue;
    const live = node.status === "running";
    if (!(live || (["done", "error", "stopped", "skipped"].includes(node.status) && node.selections_final !== true))) continue;
    if (n >= FILL_MAX_NODES || Date.now() / 1000 >= deadline) break;
    if (live && !throttleOk(home, `selections-${runId}-${node.id}`, bindSecs())) continue;
    n++;
    const r = await nodeSelectionsText(home, [runId, node.id]);
    if (r.code !== 0) continue;
    if (!live) await commit(home, runId, [(rr) => patch(rr, node.id, (x) => { x.selections_final = true; })]);
  }
}

// owners_fill_run: stall rules and session figures, the actual model, then the hub selections.
// Nodes the session table did not fill: one `opencode api GET /api/session/<id>` per node (at most 5), empty fields only.
async function apiFillRun(home: string, runId: string, ix: Sess[], dl: number): Promise<void> {
  const run = await loadRun(home, runId);
  if (!run) return;
  const bin = Bun.which("opencode", { PATH: process.env.PATH ?? "" });
  if (!bin) return;
  const known = new Set(ix.map((s) => s.id));
  const t = Number(process.env.ORCH_OWNER_CALL_TIMEOUT);
  let count = 0;
  for (const n of running(run)) {
    const id = String(n.owner_id ?? "");
    if (n.owner_kind !== "session" || id === "" || known.has(id)) continue;
    if (count >= FILL_MAX_NODES || Math.floor(Date.now() / 1000) >= dl) break;
    if (!throttleOk(home, `fill-${runId}-${n.id}`, bindSecs())) continue;
    count++;
    const r = await runLimited(t > 0 ? t : 3, [bin, "api", "GET", `/api/session/${id}`]);
    if (r.code !== 0) continue;
    let d: any;
    try { d = JSON.parse(r.out).data; } catch { continue; }
    if (!d || typeof d !== "object") continue;
    const haveModel = ((n.model ?? n.report?.model ?? "") !== "");
    const haveTok = n.report?.input_tokens != null || n.report?.output_tokens != null || Object.keys(n.usage ?? {}).length > 0;
    const haveUsd = n.report?.usd != null || n.cost != null;
    const args = [n.id];
    const num = (v: any) => (v === undefined || v === null || v === "" ? "" : String(Math.trunc(Number(v))));
    if (!haveModel && d.model?.id) args.push("--model", String(d.model.id));
    if (!haveTok && num(d.tokens?.input) !== "") args.push("--input-tokens", num(d.tokens.input));
    if (!haveTok && num(d.tokens?.output) !== "") args.push("--output-tokens", num(d.tokens.output));
    if (!haveUsd && d.cost != null && d.cost !== "") args.push("--usd", String(d.cost));
    const created = Math.floor((d.time?.created ?? 0) / 1000), updated = Math.floor((d.time?.updated ?? 0) / 1000);
    const iso = (e: number) => new Date(e * 1000).toISOString().replace(".000Z", "Z");
    const node = n.id;
    await commit(home, runId, [(rr, ctx) => {
      if (args.length > 1) applyReport(rr, parseReportArgs(args), ctx);
      const x = findNode(rr, node);
      if (!x) return;
      if ((x.harness ?? "") === "") x.harness = "opencode";
      if (x.started == null && created > 0) x.started = iso(created);
      if (updated > 0) x.last_activity = iso(updated);
    }]);
  }
}

// ---- backfill: an old node gets what is still missing, once --------------------------------------------

const BACKFILL_SELECTIONS_MAX = 30;

// What a finished node can still get after its run ended: the tier its Smart Auto model name carries, the
// model its session served, and the hub selection events (actual model, role, effort) of a job-dispatched
// node that never had `worker_identity`. A node is marked `fill_backfilled` once every source it needs
// answered, so later sweeps skip it. What the hub or the opencode database no longer holds stays empty.
export async function ownersBackfillRun(home: string, runId: string, deadline = 0): Promise<string[]> {
  if (process.env.ORCH_OWNER_FILL === "0") return [];
  const run = await loadRun(home, runId);
  if (!run) return [];
  const todo = run.nodes.filter((n) => ["done", "error", "stopped"].includes(n.status) && n.fill_backfilled !== true);
  if (todo.length === 0) return [];
  const dl = deadline || Math.floor(Date.now() / 1000) + 3600;
  await loadEnvFile(home);
  const dbOn = existsSync(opencodeDbPath());
  const hubOn = process.env.ORCH_OWNER_HUB !== "0" && (process.env.LLM_HUB_URL ?? "") !== "";
  const plan = new Map<string, { set: Record<string, any>; needsDb: boolean; needsSel: boolean }>();
  for (const n of todo) {
    const set: Record<string, any> = {};
    const named = [n.model, n.model_id].map((m) => /smart-auto-([a-z]+)$/.exec(String(m ?? ""))?.[1]).find((t) => t !== undefined && SMART_AUTO_TIERS.includes(t));
    if (n.tier == null && named !== undefined) set.tier = named;
    let needsDb = false;
    if ((n.actual_model ?? "") === "") {
      const ses = String(n.owner_id ?? "").startsWith("ses_") && alt(n.owner_kind, "session") === "session" ? String(n.owner_id) : String(n.session ?? "").startsWith("ses_") ? String(n.session) : "";
      let m = "";
      if ((n.adapter || n.harness || "") === "copilot" && (n.session ?? "") !== "") m = copilotActualModel(n.session);
      else if (n.hub?.actual?.model != null) m = String(n.hub.actual.model);
      else if (ses !== "") {
        needsDb = true;
        if (dbOn) m = dbSessionModel(ses);
      }
      if (m !== "") set.actual_model = m;
    }
    const needsSel = n.selections_final !== true && (n.job_id ?? "") !== "" && ["claude", "opencode"].includes(String(n.adapter ?? "")) && (selector(n.model) || selector(n.model_id));
    if (needsSel && (n.worker_identity ?? "") === "") set.worker_identity = `${runId}/${n.id}/${(n.attempts ?? []).length + 1}`;
    plan.set(n.id, { set, needsDb: needsDb && !dbOn, needsSel });
  }
  const changed = new Map<string, string[]>();
  await commit(home, runId, [(r) => {
    for (const [id, p] of plan) {
      patch(r, id, (x) => {
        for (const [k, v] of Object.entries(p.set)) {
          if (x[k] == null || x[k] === "") { x[k] = v; if (k !== "worker_identity") changed.set(id, [...(changed.get(id) ?? []), k]); }
        }
      });
    }
  }]);
  const selDone = new Set<string>();
  let calls = 0;
  for (const [id, p] of plan) {
    if (!p.needsSel || !hubOn) continue;
    if (calls >= BACKFILL_SELECTIONS_MAX || Date.now() / 1000 >= dl) break;
    calls++;
    const r = await nodeSelectionsText(home, [runId, id]);
    if (r.code !== 0) continue;
    selDone.add(id);
    const after = (await loadRun(home, runId))?.nodes.find((x) => x.id === id);
    if (after && (after.selection_history ?? []).length > 0) changed.set(id, [...(changed.get(id) ?? []), "selections"]);
  }
  await commit(home, runId, [(r) => {
    for (const [id, p] of plan) {
      if (p.needsDb || (p.needsSel && !selDone.has(id))) continue;
      patch(r, id, (x) => { x.fill_backfilled = true; if (selDone.has(id)) x.selections_final = true; });
    }
  }]);
  return [...changed].map(([id, keys]) => `${id}\tbackfilled ${[...new Set(keys)].join(", ")}`);
}

export async function ownersFillRun(home: string, runId: string, deadline = 0): Promise<string[]> {
  if (process.env.ORCH_OWNER_FILL === "0") return [];
  if (!existsSync(paths.runState(home, runId))) return [];
  const ix = sessionIndex();
  const lines = await ownersFillIndexRun(home, runId, ix);
  const dl = deadline || Math.floor(Date.now() / 1000) + 3600;
  await actualRun(home, runId, ix, dl).catch(() => undefined);
  await selectionsRun(home, runId, dl).catch(() => undefined);
  await apiFillRun(home, runId, ix, dl).catch(() => undefined);
  const backfilled = await ownersBackfillRun(home, runId, dl).catch(() => []);
  return [...lines, ...backfilled];
}

// ---- verify ---------------------------------------------------------------------------------------

export function ownerReportLines(rows: string[][]): string[] {
  const pick = (s: string) => rows.filter((r) => r[1] === s).map((r) => r[0]).join(",");
  const f = pick("finished"), i = pick("idle"), g = pick("gone");
  return [...(f ? [`owner finished: ${f}`] : []), ...(i ? [`owner idle: ${i}`] : []), ...(g ? [`owner gone: ${g}`] : [])];
}

// owners_verify_run: rows [node, owner_state, note] per checked node. apply=false reads only.
export async function ownersVerifyRun(home: string, runId: string, apply: boolean, deadline = 0): Promise<string[][]> {
  if (process.env.ORCH_OWNER_VERIFY === "0") return [];
  const dl = deadline || Math.floor(Date.now() / 1000) + Number(process.env.ORCH_OWNER_TOTAL_SECS ?? OWNER_TOTAL_SECS_DEFAULT);
  if (apply) await ownersBindRun(home, runId).catch(() => undefined);
  const run = await loadRun(home, runId);
  if (!run) return [];
  const want = running(run).map((n) => n.owner_id).filter(Boolean);
  const known = new Map(sessionIndex().filter((s) => want.includes(s.id)).map((s) => [s.id, s.busy ? "alive" : "idle"]));
  const rows: string[][] = [];
  const ops: Op[] = [];
  for (const n of running(run)) {
    if ((n.owner ?? "") === "" || ["unbound", "umbrella"].includes(n.owner_kind ?? "")) continue;
    const text = n.owner_bind === "job" && (n.job_id ?? "") !== "" ? String(n.job_id)
      : n.owner_kind === "session" && String(n.owner_id ?? "").startsWith("ses_") ? `ses ${n.owner_id}`
      : String(n.owner).replace(/[\t\r\n]/g, " ");
    let kind: string, id: string;
    if (text.startsWith("ses ")) { kind = "session"; id = text.slice(4); } else [kind, id] = ownerParse(text, paths.jobs(home));
    if (!["session", "process", "job"].includes(kind)) continue;
    if (kind === "job" && id === (n.job_id ?? "")) continue;
    let state: string, note = "";
    const k = known.get(id);
    if (k) state = k;
    else [state, note] = await ownerStateCached(home, kind, id, dl);
    if (state === "finished" && kind !== "job") state = "idle";
    const prev = n.owner_state ?? "";
    const node = n.id;
    if (apply) {
      const now = nowIso();
      ops.push((r, ctx) => {
        applyOwnerState(r, ctx, node, state, note, id, OWNER_BY, now);
        if (state !== prev && (state !== "alive" || prev !== "")) emit(ctx, OWNER_BY, "owner", node, prev, state, `owner ${id}: ${state}`);
      });
    }
    rows.push([node, state, note]);
  }
  if (apply) {
    await commit(home, runId, ops);
    await ownersFillRun(home, runId, dl).catch(() => []);
  }
  return rows;
}

async function runningRunIds(home: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(paths.runs(home)).catch(() => [] as string[])) {
    const r = await loadRun(home, d).catch(() => null);
    if (r && r.status === "running") out.push(String(r.run_id ?? d));
  }
  return out;
}

// ---- commands -------------------------------------------------------------------------------------

export async function nodeVerifyOwners(args: string[]): Promise<number> {
  let runArg = "", json = false, apply = true;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--no-apply") apply = false;
    else if (a.startsWith("-")) { err(`node verify-owners: unknown argument ${a}\n  usage: ${NODE_VERIFY_OWNERS_USAGE}`); return 2; }
    else runArg = a;
  }
  const home = orchHome();
  let ids: string[];
  if (runArg !== "") {
    const id = await resolveRun(home, runArg);
    if (id === null) return 1;
    if (!existsSync(paths.runState(home, id))) { err(`run ${id}: unknown run`); return 2; }
    ids = [id];
  } else ids = await runningRunIds(home);
  const dl = Math.floor(Date.now() / 1000) + Number(process.env.ORCH_OWNER_TOTAL_SECS ?? OWNER_TOTAL_SECS_DEFAULT);
  const rows: string[][] = [];
  for (const id of ids) for (const r of await ownersVerifyRun(home, id, apply, dl)) rows.push([id, ...r]);
  if (json) {
    process.stdout.write(JSON.stringify(rows.map((r) => ({ run: r[0], node: r[1], owner_state: r[2], note: r[3] ?? "" })), null, 2) + "\n");
    return 0;
  }
  for (const r of rows) process.stdout.write(`${r[0]} ${r[1]}: owner ${r[2]}${(r[3] ?? "") !== "" ? ` - ${r[3]}` : ""}\n`);
  return 0;
}

export async function nodeBindOwners(args: string[]): Promise<number> {
  let runArg = "", json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--run") runArg = args[++i] ?? "";
    else if (a === "--json") json = true;
    else { err(`node bind-owners: unknown argument ${a}\n  usage: ${NODE_BIND_OWNERS_USAGE}`); return 2; }
  }
  const home = orchHome();
  let ids: string[];
  if (runArg !== "") {
    const id = await resolveRun(home, runArg);
    if (id === null) return 1;
    if (!existsSync(paths.runState(home, id))) { err(`run ${id}: unknown run`); return 2; }
    ids = [id];
  } else ids = await runningRunIds(home);
  const rows: string[][] = [];
  for (const id of ids) {
    const out = [...(await ownersBindRun(home, id).catch(() => [])), ...(await ownersFillRun(home, id).catch(() => []))];
    for (const l of out) rows.push([id, ...l.split("\t")]);
  }
  if (json) {
    process.stdout.write(JSON.stringify(rows.map((r) => ({ run: r[0], node: r[1], result: r[2] })), null, 2) + "\n");
    return 0;
  }
  for (const r of rows) process.stdout.write(`${r[0]} ${r[1]}: ${r[2]}\n`);
  return 0;
}

export async function nodeBrief(args: string[]): Promise<number> {
  const [runArg = "", nodeId = ""] = args;
  if (!runArg || !nodeId) { err(`usage: ${NODE_BRIEF_USAGE}`); return 2; }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) { err(`run ${runId}: unknown run`); return 2; }
  if (!findNode(run, nodeId)) { err(`node ${nodeId}: not in this run`); return 2; }
  process.stdout.write(`You are node "${nodeId}" of orch run "${runId}". Your task is in $ORCH_NODE_GOAL and in the file $ORCH_NODE_GOAL_FILE. Keep the run graph true with these orch commands:
- At least every 5 minutes while you work: orch node ping ${runId} ${nodeId} --note "<what you just did>" [--progress 3/10]
- When you know your real model and token numbers: orch node report ${runId} ${nodeId} --model <model> --input-tokens N --output-tokens N --note "<summary>"
- When the work is finished: write handoff.md (the long detail) in $ORCH_NODE_OUT, then right after it record the one-line result: orch node result ${runId} ${nodeId} --verdict full|partial|blocked --summary "<one sentence>" --follow-up "<findings or none>". (Inside the node, "orch node result --verdict ... --summary ... --follow-up ..." works too: it reads ORCH_RUN_ID and ORCH_NODE_ID.) blocked needs a summary. The main session reads handoff.md only when the result says partial, blocked or has a follow_up.
- When the work is finished AND verified (tests ran, output read): orch node update ${runId} ${nodeId} done
- On failure: orch node update ${runId} ${nodeId} error --error "<reason>"
Rules: never redirect a command to /dev/null (no >/dev/null, no 2>/dev/null). Read the result of every orch command. Never mark done before you verified the work.
`);
  return 0;
}

// Newest messages of the node's owner session as JSON; exit 4 no checkable owner, 3 gone, 1 unreachable.
export async function nodeActivity(args: string[]): Promise<number> {
  const [runArg = "", nodeId = ""] = args;
  if (!runArg || !nodeId) { err(`usage: ${NODE_ACTIVITY_USAGE}`); return 2; }
  let limit = 20;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--limit") limit = Number(args[++i] ?? 20) || 20;
    else { err(`node activity: unknown argument ${args[i]}`); return 2; }
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) { err(`run ${runId}: unknown run`); return 2; }
  const n = findNode(run, nodeId);
  if (!n) { err(`node ${nodeId}: not in this run`); return 2; }
  const [kind, id] = ownerParse(String(n.owner ?? ""), paths.jobs(home));
  if (kind !== "session") return 4;
  const s = dbQuery("select id from session_v2 where id = ?", id);
  if (s === null) return 1;
  if (s.length === 0) return 3;
  const msgs = dbQuery("select seq, type, data, time_created from session_message where session_id = ? order by seq desc limit ?", id, limit) ?? [];
  const data = msgs.map((m) => {
    let d: any = m.data;
    try { d = JSON.parse(m.data); } catch { /* keep raw */ }
    return { seq: m.seq, type: m.type, time: { created: m.time_created }, ...(typeof d === "object" && d ? d : { data: d }) };
  });
  process.stdout.write(JSON.stringify({ data }) + "\n");
  return 0;
}

// owner event: harness-neutral push from a plugin or hook. Unknown ids are ignored; never fails the caller.
export async function ownerEvent(args: string[]): Promise<number> {
  const [sid = "", kind = ""] = args;
  if (!sid || !kind) { err(`usage: ${OWNER_EVENT_USAGE}`); return 2; }
  let note = "", harness = "unknown";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--note") note = args[++i] ?? "";
    else if (args[i] === "--harness") harness = args[++i] ?? "unknown";
  }
  const home = orchHome();
  const regFile = join(paths.owners(home), `${ownerSafe(sid)}.json`);
  const reg = await Bun.file(regFile).json().catch(() => null);
  if (!reg?.run || !reg?.node) return 0;
  const run = await loadRun(home, reg.run);
  const node = run ? findNode(run, reg.node) : undefined;
  if (!run || !node) return 0;
  const by = `owner-event:${harness}`;
  const now = nowIso();
  const started = (r: RunState, ctx: Ctx) => patch(r, reg.node, (x) => {
    if (x.status === "running" && (x.seg_open ?? false) && x.started_at == null) {
      x.started_at = x.dispatched_at != null && now < x.dispatched_at ? x.dispatched_at : now;
      emit(ctx, by, "started", reg.node, "starting", "running", by);
    }
  });
  switch (kind) {
    case "started":
      if (node.status === "waiting") await mutateRun(home, reg.run, (r, ctx) => { ctx.by = by; setStatus(r, reg.node, "running", "", "", "", sid, ctx); });
      else if (node.status === "running") await commit(home, reg.run, [started]);
      return 0;
    case "alive": {
      if (node.status !== "running") return 0;
      const last = node.owner_checked ? isoEpoch(node.owner_checked) : 0;
      const recent = last > 0 && Math.floor(Date.now() / 1000) - last < HEARTBEAT_DEBOUNCE_SECS;
      await commit(home, reg.run, [started, ...(recent ? [] : [(r: RunState, ctx: Ctx) => applyOwnerState(r, ctx, reg.node, "alive", "", sid, by, now)])]);
      return 0;
    }
    case "finished":
    case "failed":
      if (node.status !== "running") return 0;
      await commit(home, reg.run, [(r, ctx) => applyOwnerState(r, ctx, reg.node, kind, note, sid, by, now)]);
      return 0;
    default:
      err(`owner event: unknown kind ${kind}`);
      return 2;
  }
}
