// Node operations on a run: add, update, report. Bun port of lib/runs/runs.sh (cmd_node_add,
// cmd_node_update, cmd_node_report, node_set_status, owner_register, node_done_verify) and of the
// per-op rules in lib/runs/batch.sh. Works on an in-memory run object. The caller loads and saves
// state.json under the run lock. Each op validates everything before it mutates, so a failing op
// leaves the run as it was. Messages match the bash text byte for byte.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { epochOf, nowIso } from "../state/clock.ts";
import { paths } from "../state/home.ts";
import { readJson, type RunState } from "../state/store.ts";
import { ENGINE_ORIGINS, isEngineNode } from "../../../../src/shared/engine-node.ts";

export const NODE_STATUSES = ["waiting", "running", "done", "error", "skipped", "stopped"];
export const WORK_ROLES = ["planning", "investigation", "implementation", "validation", "conversation"];
export const SMART_AUTO_TIERS = ["efficiency", "balance", "intelligence", "fast"];
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_PATTERN_TEXT = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const ADVANCE_INTERVAL_DEFAULT = 15;
const RETRY_BACKOFF_CAP_SECS = 300;
const HUB_ROLE_TIERS_DEFAULT: Record<string, string> = {
  planning: "intelligence",
  investigation: "balance",
  implementation: "balance",
  validation: "efficiency",
  conversation: "fast",
};

export const USAGE = {
  add: 'dispatch.ts node add <run-id> <node-id> "<label>" [--after a,b] [--profile P] [--role R] [--tier T] [--model M] [--plan-backed] [--acceptance "<checks>"] [--origin loop|watch]',
  report: "dispatch.ts node report <run-id> <node-id> [--model M] [--input-tokens N] [--output-tokens N] [--cache-read-tokens N] [--usd X] [--note \"text\"]",
  update: `dispatch.ts node update <run-id> <node-id> [${NODE_STATUSES.join("|")}] [--job J] [--error "msg"] [--at <iso>] [--owner <text>] [--force] [--reason T] [--after a,b|'*'|""] [--needs-user "reason"|--clear-needs-user] [--hold "reason"|--clear-hold]`,
  batch: "dispatch.ts node batch <run-id> [--file F] [--dry-run]   (one JSON op per line on stdin or in F)",
};

// An op failure. The message is the stderr text (without the trailing newline).
export class OpError extends Error {}

function fail(msg: string): never {
  throw new OpError(msg);
}

const nn = (s: string | null | undefined): string | null => (s === undefined || s === null || s === "" ? null : s);

export interface Ev {
  at: string;
  kind: string;
  node: string | null;
  from: string | null;
  to: string | null;
  note: string | null;
  by: string;
}

export interface Hub {
  on: boolean;
  profile: string;
  roleTiers: Record<string, unknown>;
}

// Per-command context: the clock, the writer name, and the side effects an op queues.
export interface Ctx {
  home: string;
  runId: string;
  now: string;
  by: string;
  hub: Hub;
  // Chain of runs this run continued from (run_chain), with their state. Read-only.
  chain: Array<{ id: string; run: RunState }>;
  // batch: done-verify waits until the batch ends (batch.sh fast path).
  batch: boolean;
  verify: string[];
  events: Ev[];
  owners: Array<{ file: string; body: Record<string, unknown> }>;
  stderr: string[];
}

export function newCtx(home: string, runId: string, opts: Partial<Ctx> = {}): Ctx {
  return {
    home,
    runId,
    now: nowIso(),
    by: process.env.ORCH_EVENT_BY || "cli",
    hub: { on: false, profile: "", roleTiers: {} },
    chain: [],
    batch: false,
    verify: [],
    events: [],
    owners: [],
    stderr: [],
    ...opts,
  };
}

// hub_mode_on / hub_profile / hub_role_tier from lib/adapters/hub.sh, read from profiles.json.
export async function loadHub(home: string): Promise<Hub> {
  const off: Hub = { on: false, profile: "", roleTiers: {} };
  const f = paths.profiles(home);
  if (!(await Bun.file(f).exists())) return off;
  const p = await readJson<any>(f).catch(() => null);
  const h = p?.settings?.llm_hub ?? {};
  const harness = typeof h.harness === "string" && h.harness !== "" ? h.harness : "opencode";
  return {
    on: h.mode === "smart-auto",
    profile: `${harness}-smart-auto`,
    roleTiers: typeof h.role_tiers === "object" && h.role_tiers !== null ? h.role_tiers : {},
  };
}

function hubRoleTier(hub: Hub, role: string): string {
  if (!role) return "";
  const c = hub.roleTiers[role];
  if (typeof c === "string" && SMART_AUTO_TIERS.includes(c)) return c;
  return HUB_ROLE_TIERS_DEFAULT[role] ?? "";
}

// The run and the runs it continued from, newest first (run_chain).
export async function loadChain(home: string, run: RunState): Promise<Ctx["chain"]> {
  const out: Ctx["chain"] = [];
  let id: string | null = run.continued_from ?? null;
  let n = 0;
  while (id && n < 20) {
    const r = (await readJson<RunState>(paths.runState(home, id)).catch(() => null)) as RunState | null;
    if (!r) break;
    out.push({ id, run: r });
    id = r.continued_from ?? null;
    n++;
  }
  return out;
}

export function chainIds(ctx: Ctx): string[] {
  return [ctx.runId, ...ctx.chain.map((c) => c.id)];
}

export function ev(ctx: Ctx, kind: string, node: string, from: string, to: string, note: string): void {
  ctx.events.push({
    at: ctx.now,
    kind,
    node: nn(node),
    from: nn(from),
    to: nn(to),
    note: nn(note),
    by: ctx.by,
  });
}

export function findNode(run: RunState, id: string): Record<string, any> | undefined {
  return run.nodes.find((n) => n.id === id);
}

function requireNode(run: RunState, id: string): Record<string, any> {
  const n = findNode(run, id);
  if (!n) fail(`node ${id}: not in this run`);
  return n;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isUint(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

// Shared parse of `<flag> <value>` lists. Boolean flags take no value.
function nextValue(args: string[], i: number): string {
  return args[i + 1] ?? "";
}

// ---- add -----------------------------------------------------------------------------------------

export interface AddArgs {
  id: string;
  label: string;
  after: string;
  profile: string;
  role: string;
  tier: string;
  model: string;
  planBacked: boolean;
  acceptance: string;
  /** Set by an engine that makes nodes itself (the loop runner): the watchdog never retries or verifies these. */
  origin?: string;
}


// argv after `node add <run>`: <id> <label> [flags]. Checks the enumerations, as cmd_node_add does.
export function parseAddArgs(args: string[]): AddArgs {
  const a: AddArgs = { id: args[0] ?? "", label: args[1] ?? "", after: "", profile: "", role: "", tier: "", model: "", planBacked: false, acceptance: "", origin: "" };
  let i = 2;
  while (i < args.length) {
    const k = args[i];
    switch (k) {
      case "--after": a.after = nextValue(args, i); i++; break;
      case "--profile": a.profile = nextValue(args, i); i++; break;
      case "--role": a.role = nextValue(args, i); i++; break;
      case "--tier": a.tier = nextValue(args, i); i++; break;
      case "--model": a.model = nextValue(args, i); i++; break;
      case "--plan-backed": a.planBacked = true; break;
      case "--acceptance": a.acceptance = nextValue(args, i); i++; break;
      case "--origin": a.origin = nextValue(args, i); i++; break;
      default: fail(`node add: unknown argument ${k}`);
    }
    i++;
  }
  if (a.role && !WORK_ROLES.includes(a.role)) fail(`node add: --role must be one of: ${WORK_ROLES.join(" ")}`);
  if (a.tier && !SMART_AUTO_TIERS.includes(a.tier)) fail(`node add: --tier must be one of: ${SMART_AUTO_TIERS.join(" ")}`);
  if (a.origin && !ENGINE_ORIGINS.includes(a.origin)) fail(`node add: --origin must be one of: ${ENGINE_ORIGINS.join(" ")}`);
  return a;
}

export function applyAdd(run: RunState, a: AddArgs, ctx: Ctx): string {
  let profile = a.profile;
  let tier = a.tier;
  if (ctx.hub.on) {
    if (!profile) profile = ctx.hub.profile;
    if (!tier) tier = hubRoleTier(ctx.hub, a.role);
  }
  if (!ID_PATTERN.test(a.id)) fail(`node add: id must match ${ID_PATTERN_TEXT}`);
  if (findNode(run, a.id)) fail(`node add: ${a.id} already exists`);
  const kept: string[] = [];
  const deps = a.after.split(/[,\s]+/).filter((d) => d.length > 0);
  for (const dep of deps) {
    if (dep === a.id) fail(`node add: ${a.id} cannot depend on itself`);
    if (findNode(run, dep)) {
      kept.push(dep);
      continue;
    }
    const origin = ctx.chain.find((c) => (c.run.nodes ?? []).some((n: any) => n.id === dep && n.status === "done"));
    if (origin) {
      ctx.stderr.push(`dependency ${dep} is finished in run ${origin.id}`);
      continue;
    }
    fail(`node add: dependency ${dep} is not in run ${ctx.runId} or in the runs it continued (searched: ${chainIds(ctx).join(" ")} )`);
  }
  run.nodes.push({
    id: a.id,
    label: a.label,
    status: "waiting",
    profile: nn(profile),
    adapter: null,
    model: nn(a.model),
    model_id: null,
    job_id: null,
    session: null,
    started: null,
    finished: null,
    error: null,
    log_tail: [],
    usage: {},
    cost: null,
    created: ctx.now,
    updated: ctx.now,
    prompt: null,
    dispatch_args: [],
    attempts: [],
    role: nn(a.role),
    tier: nn(tier),
    plan_backed: a.planBacked,
    acceptance: nn(a.acceptance),
    ...(a.origin ? { origin: a.origin } : {}),
  });
  run.edges = [...(run.edges ?? []), ...kept.map((d) => [d, a.id])];
  // The done-gate stays last: a node added after it ran makes it wait again.
  const gate = findNode(run, "done-gate");
  if (gate && gate.after_all && a.id !== "done-gate" && ["done", "error", "skipped"].includes(gate.status)) {
    Object.assign(gate, { status: "waiting", finished: null, error: null, unverified: null, next_retry_at: null, skip_reason: null, updated: ctx.now });
  } else if (gate && gate.after_all && a.id !== "done-gate" && gate.status === "running") {
    // The running gate verified a node list that no longer holds: it ends as an error, or waits again.
    gate.rerun = true;
  }
  ev(ctx, "add", a.id, "", "waiting", a.label);
  return `add ${a.id} "${a.label}"`;
}

// ---- timing and retry ----------------------------------------------------------------------------

// seg_close($at) from lib/runs/timing.sh: closes the open segment into run_segments.
export function segClose(n: Record<string, any>, at: string): void {
  if (!n.seg_open) return;
  if (n.started_at == null && (n.dispatched_at ?? at) >= at) {
    // A segment that never started and ends at its own dispatch time is dropped.
  } else {
    n.run_segments = [...(n.run_segments ?? []), { dispatched: n.dispatched_at ?? null, start: n.started_at ?? null, end: at }];
  }
  n.seg_open = false;
}

// retry_delay_seconds: base doubled per prior attempt, capped at 300 s.
function retryDelaySeconds(attempts: number, base: number): number {
  let delay = base;
  for (let i = 0; i < attempts && delay < RETRY_BACKOFF_CAP_SECS; i++) {
    delay = Math.min(delay * 2, RETRY_BACKOFF_CAP_SECS);
  }
  return delay;
}

function retryBase(): number {
  const raw = process.env.ORCH_AUTO_RETRY_BASE_SECS ?? "";
  return /^[0-9]+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : ADVANCE_INTERVAL_DEFAULT;
}

export function nextRetryAt(n: Record<string, any>, now: string): string {
  const delay = retryDelaySeconds((n.attempts ?? []).length, retryBase());
  return nowIso(new Date(((epochOf(now) ?? 0) + delay) * 1000));
}

// node_archive_attempt with the reset-to-waiting reason (set_status, waiting after error).
export function archiveAttempt(n: Record<string, any>, reason = "reset to waiting", retryMode = "", retrySession = ""): void {
  n.attempts = [
    ...(n.attempts ?? []),
    {
      job_id: n.job_id ?? null,
      error: n.error ?? null,
      finished: n.finished ?? null,
      log_tail: n.log_tail ?? [],
      profile: n.profile ?? null,
      adapter: n.adapter ?? null,
      model: n.model ?? null,
      model_id: n.model_id ?? null,
      actual_model: n.actual_model ?? null,
      cost: n.cost ?? null,
      session: n.session ?? null,
      reason: reason || null,
      retry_mode: retryMode || null,
      retry_session: retrySession || null,
    },
  ];
}

// ---- owners --------------------------------------------------------------------------------------

// owner_parse (lib/runs/owners.sh): none | session | process | job | unknown.
export function ownerParse(text: string, jobsDir: string): [string, string] {
  const t = text.trim();
  if (t === "") return ["none", ""];
  if (t.toLowerCase() === "coordinator") return ["none", "coordinator"];
  const s = /^(agent[\s:]+)?(ses_[A-Za-z0-9]+)$/.exec(t);
  if (s) return ["session", s[2]!];
  const p = /^pid[:\s]+([0-9]+)$/i.exec(t);
  if (p) return ["process", p[1]!];
  if (isDir(join(jobsDir, t))) return ["job", t];
  return ["unknown", t];
}

import { bindApply, ownerLiteralId } from "../commands/owners.ts";

// owner_register: stores owner_kind/owner_id on the node. A running node with a known id queues its
// owners/<id>.json. Binding of unknown owner text (owner_bind_literal) is not ported yet.
function ownerRegister(run: RunState, id: string, ctx: Ctx, explicit: boolean): void {
  const n = requireNode(run, id);
  const owner = String(n.owner ?? "");
  if (!owner) return;
  if (!explicit && n.owner_bind && n.owner_kind === "session" && String(n.owner_id ?? "").startsWith("ses_")) return;
  const [kind, oid] = ownerParse(owner, paths.jobs(ctx.home));
  n.owner_kind = kind;
  n.owner_id = oid === "" ? null : oid;
  if (n.status !== "running" || oid === "") return;
  if (kind !== "unknown") {
    ctx.owners.push({
      file: `${oid.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
      body: { run: ctx.runId, node: id, since: ctx.now },
    });
  } else {
    // The text often carries a real id after other words ("agent ses_x (spawned)"): bind it right away.
    const [lk, li] = ownerLiteralId(owner);
    if (lk !== "none") bindApply(run, ctx, id, lk, li, "literal");
  }
}

// ---- status --------------------------------------------------------------------------------------

// node_set_status: the one path every status change takes. Stamps timing, owner and retry fields.
export function setStatus(run: RunState, id: string, status: string, job: string, err: string, at: string, owner: string, ctx: Ctx, dispatching = false): void {
  const n = requireNode(run, id);
  const old = String(n.status ?? "");
  const eventAt = at || ctx.now;
  const ownerVal = owner || (status === "running" && job ? job : "");
  const retry = status === "error" ? nextRetryAt(n, ctx.now) : "";
  if (status === "waiting" && old === "error") archiveAttempt(n);

  {
    if (dispatching && status === "running") {
      if (n.seg_open && old === "running") {
        n.dispatched_at = n.dispatched_at ?? eventAt;
      } else {
        if (old !== "running") segClose(n, eventAt);
        n.dispatched_at = eventAt;
        n.started_at = null;
        n.finished_at = null;
        n.seg_open = true;
      }
    } else if (status === "running" && !n.seg_open) {
      n.dispatched_at = eventAt;
      n.started_at = eventAt;
      n.finished_at = null;
      n.seg_open = true;
    } else if (status === "running" && n.started_at == null) {
      n.started_at = n.dispatched_at != null && eventAt < n.dispatched_at ? n.dispatched_at : eventAt;
    } else if (["done", "error", "skipped", "stopped"].includes(status)) {
      segClose(n, eventAt);
      n.finished_at = eventAt;
    } else if (status === "waiting") {
      segClose(n, eventAt);
      n.dispatched_at = null;
      n.started_at = null;
      n.finished_at = null;
    }
  }

  n.status = status;
  n.updated = ctx.now;
  if ((status === "done" || status === "error") && n.started == null) {
    n.started = n.created ?? eventAt;
    n.backfilled = true;
  }
  if (job) n.job_id = job;
  if (err) n.error = err;
  if (status === "running" && n.started == null) n.started = eventAt;
  if (status === "running") {
    n.backfilled = false;
    n.hold = null;
  }
  if (ownerVal) n.owner = ownerVal;
  if (status === "waiting") {
    n.result = null;
    n.handoff_reason = null;
    n.result_reason = null;
    n.unverified = null;
    for (const k of ["started", "finished", "error", "owner", "job_id", "owner_kind", "owner_id", "owner_state"]) n[k] = null;
  }
  if (status === "done" && ctx.by !== "owner-liveness") {
    n.unverified = null;
    n.auto = null;
  }
  if (status === "done" || status === "error" || status === "skipped") n.finished = eventAt;
  if (status === "error") n.next_retry_at = retry;
  else if (["running", "waiting", "done", "skipped"].includes(status)) n.next_retry_at = null;

  ownerRegister(run, id, ctx, owner !== "");
  ev(ctx, "status", id, old, status, err);
}

// node_done_verify: a done node must leave a non-empty handoff.md. Otherwise: one stderr line and
// `unverified` on the node.
// Why a handoff file does not count: "missing" | "empty" | "stale" (older than the node's latest attempt) | "" when it counts.
// The latest attempt starts at started_at (else dispatched_at); both are whole-second ISO times, so the mtime is compared at second grain.
export function handoffProblem(file: string, n: Record<string, any>): "" | "missing" | "empty" | "stale" {
  let st;
  let text: string;
  try {
    st = statSync(file);
    text = readFileSync(file, "utf8");
  } catch {
    return "missing";
  }
  if (text.trim() === "") return "empty";
  const start = epochOf(String(n.started_at ?? n.dispatched_at ?? ""));
  if (start !== null && st.mtimeMs < start * 1000) return "stale";
  return "";
}

export const VERDICTS = ["full", "partial", "blocked"];
export const RESULT_USAGE = `dispatch.ts node result [<run-id> <node-id>] --verdict ${VERDICTS.join("|")} --summary "<one sentence>" [--follow-up "<findings or none>"]   (run and node default to ORCH_RUN_ID and ORCH_NODE_ID)`;

// One line: newlines and runs of spaces collapse so the result stays on one line everywhere it is shown.
export const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

// A node that finishes with no recorded result gets verdict "unknown" and one stderr warning.
export function ensureResult(run: RunState, id: string, ctx: Ctx): void {
  const n = requireNode(run, id);
  if (isEngineNode(ctx.runId, n)) return;
  const r = n.result;
  if (r && typeof r === "object" && typeof r.verdict === "string") {
    n.result_reason = null;
    return;
  }
  n.result = { verdict: "unknown", summary: "", follow_up: "", at: ctx.now };
  n.result_reason = "node result was not recorded";
  ctx.stderr.push(`done without a result: ${id} recorded verdict unknown. Record it: orch node result <run> ${id} --verdict full|partial|blocked --summary "..." --follow-up "..."`);
}

// A done node whose result asks for follow-up: partial or blocked, and the follow_up is not "none".
export function needsFollowUp(n: Record<string, any>): boolean {
  const r = n.result;
  if (!r || (r.verdict !== "partial" && r.verdict !== "blocked")) return false;
  return oneLine(String(r.follow_up ?? "")).toLowerCase().replace(/[.\s]+$/, "") !== "none";
}

// The one-line form shown in wait lines, status and node show: "[verdict] summary | follow_up: text".
export function resultText(n: Record<string, any>, max = 0): string {
  const r = n.result;
  if (!r || typeof r !== "object") return "";
  const fu = oneLine(String(r.follow_up ?? ""));
  const sum = oneLine(String(r.summary ?? ""));
  let t = [sum, fu && fu.toLowerCase() !== "none" ? `follow_up: ${fu}` : ""].filter(Boolean).join(" | ");
  if (max > 0 && t.length > max) t = t.slice(0, max - 1) + "…";
  return `[${String(r.verdict)}]${t ? " " + t : ""}`;
}

export interface ResultArgs { pos: string[]; id: string; verdict: string; summary: string; followUp: string; followSet: boolean }

export function parseResultArgs(args: string[]): ResultArgs {
  const a: ResultArgs = { pos: [], id: "", verdict: "", summary: "", followUp: "", followSet: false };
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const k = args[i]!;
    if (k === "--verdict") a.verdict = nextValue(args, i++);
    else if (k === "--summary") a.summary = nextValue(args, i++);
    else if (k === "--follow-up") { a.followUp = nextValue(args, i++); a.followSet = true; }
    else if (k.startsWith("-")) fail(`node result: unknown argument ${k}\n  usage: ${RESULT_USAGE}`);
    else pos.push(k);
  }
  a.pos = pos;
  a.id = pos[1] ?? "";
  return a;
}

export function applyResult(run: RunState, a: ResultArgs, ctx: Ctx): string {
  const n = requireNode(run, a.id);
  if (!VERDICTS.includes(a.verdict)) fail(`node result: --verdict must be one of: ${VERDICTS.join(" ")}`);
  const summary = oneLine(a.summary);
  if (a.verdict === "blocked" && summary === "") fail("node result: a blocked verdict needs a non-empty --summary");
  if (summary === "") fail("node result: --summary is required");
  const follow = oneLine(a.followUp) || (a.verdict === "full" ? "none" : "");
  n.result = { verdict: a.verdict, summary, follow_up: follow, at: ctx.now };
  n.result_reason = null;
  n.updated = ctx.now;
  ev(ctx, "note", a.id, "", "", `result ${a.verdict}: ${summary}`);
  return `result ${a.id}`;
}

export function doneVerify(run: RunState, id: string, ctx: Ctx): void {
  const n = requireNode(run, id);
  if (isEngineNode(ctx.runId, n)) return;
  ensureResult(run, id, ctx);
  const recorded = typeof n.out_dir === "string" && n.out_dir !== "" ? n.out_dir : "";
  const handoff = join(recorded || paths.runOutDir(ctx.home, ctx.runId, id), "handoff.md");
  const why = handoffProblem(handoff, n);
  if (why === "") {
    n.handoff_reason = null;
    n.unverified = n.result_reason ? true : null;
    return;
  }
  n.handoff_reason = why === "missing"
    ? "handoff.md is missing"
    : why === "empty"
      ? "handoff.md is empty"
      : "handoff is older than the latest attempt";
  ctx.stderr.push(`done without handoff: ${id} (${handoff} ${why === "stale" ? "is older than the latest attempt" : "missing or empty"}), marked unverified`);
  n.unverified = true;
  ev(ctx, "note", id, "", "", "done without handoff: marked unverified");
}

// ---- update --------------------------------------------------------------------------------------

export interface UpdateArgs {
  id: string;
  status: string;
  job: string;
  err: string;
  at: string;
  owner: string;
  force: boolean;
  reason: string;
  depsSet: boolean;
  deps: string;
  needsSet: boolean;
  needs: string;
  holdSet: boolean;
  hold: string;
}

// argv after `node update <run>`: <id> [status] [flags]. Parse errors come before any run read.
export function parseUpdateArgs(args: string[]): UpdateArgs {
  const a: UpdateArgs = {
    id: args[0] ?? "",
    status: "",
    job: "",
    err: "",
    at: "",
    owner: "",
    force: false,
    reason: "",
    depsSet: false,
    deps: "",
    needsSet: false,
    needs: "",
    holdSet: false,
    hold: "",
  };
  let i = 1;
  if (args[1] !== undefined && args[1] !== "" && !args[1].startsWith("-")) {
    a.status = args[1];
    i = 2;
  }
  while (i < args.length) {
    const k = args[i];
    switch (k) {
      case "--job": a.job = nextValue(args, i); i++; break;
      case "--error": a.err = nextValue(args, i); i++; break;
      case "--at": a.at = nextValue(args, i); i++; break;
      case "--owner": a.owner = nextValue(args, i); i++; break;
      case "--force": a.force = true; break;
      case "--reason": {
        const v = args[i + 1];
        if (v === undefined || v === "" || v.startsWith("--")) fail("node update: --reason expects a text, not a flag");
        a.reason = v;
        i++;
        break;
      }
      case "--after":
        if (i + 1 >= args.length) fail('node update: --after expects a,b or "*" (or "" to clear)');
        a.deps = args[i + 1]!;
        a.depsSet = true;
        i++;
        break;
      case "--needs-user":
        a.needs = nextValue(args, i);
        a.needsSet = true;
        i++;
        if (!a.needs) fail("node update: --needs-user expects a reason (use --clear-needs-user to clear)");
        break;
      case "--clear-needs-user": a.needs = ""; a.needsSet = true; break;
      case "--hold":
        a.hold = nextValue(args, i);
        a.holdSet = true;
        i++;
        if (!a.hold) fail("node update: --hold expects a reason (use --clear-hold to clear)");
        break;
      case "--clear-hold": a.hold = ""; a.holdSet = true; break;
      default: fail(`node update: unknown argument ${k}`);
    }
    i++;
  }
  if (a.status === "skipped" && a.force && !a.reason) fail(`node update: skipping with --force needs --reason "<why>"`);
  if (!a.status && !a.depsSet && !a.needsSet && !a.holdSet) fail(`usage: ${USAGE.update}`);
  return a;
}

// node_deps_check: a normalized `after` list, or a failure. `*` is kept as a gate marker.
function depsCheck(run: RunState, ctx: Ctx, id: string, list: string): string {
  const parts = list.split(",").map((p) => p.replace(/ /g, "")).filter((p) => p.length > 0);
  const out: string[] = [];
  for (const d of parts) {
    if (d === "*") {
      out.push(d);
      continue;
    }
    if (d === id) fail(`node update: ${id} cannot depend on itself`);
    if (!findNode(run, d)) fail(`node update: dependency ${d} is not in run ${ctx.runId}`);
    out.push(d);
  }
  const edges: Array<[string, string]> = run.edges ?? [];
  const reach = new Set<string>([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [from, to] of edges) {
      if (reach.has(from) && !reach.has(to)) {
        reach.add(to);
        changed = true;
      }
    }
  }
  const cyc = out.filter((d) => d !== "*" && reach.has(d));
  if (cyc.length > 0) {
    fail(`node update: --after ${out.join(",")} would make a cycle (${cyc.join(",")} already waits on ${id})`);
  }
  return out.join(",");
}

// node_set_deps_block: replaces incoming edges and the after_all flag, and sets or clears
// needs_user and hold. One event per block that changed.
function depsBlock(run: RunState, a: UpdateArgs, deps: string, ctx: Ctx): void {
  const n = requireNode(run, a.id);
  if (a.depsSet) {
    const d = deps.split(",").filter((x) => x.length > 0);
    run.edges = [
      ...(run.edges ?? []).filter((e: [string, string]) => e[1] !== a.id),
      ...d.filter((x) => x !== "*").map((x) => [x, a.id]),
    ];
    n.after_all = d.includes("*");
    n.updated = ctx.now;
  }
  if (a.needsSet) {
    n.needs_user = nn(a.needs);
    n.updated = ctx.now;
  }
  if (a.holdSet) {
    n.hold = nn(a.hold);
    n.updated = ctx.now;
  }
  if (a.depsSet) ev(ctx, "deps", a.id, "", "", `after: ${deps || "none"}`);
  if (a.needsSet) ev(ctx, "needs-user", a.id, "", "", a.needs || "cleared");
  if (a.holdSet) ev(ctx, "hold", a.id, "", "", a.hold || "cleared");
}

const ALLOWED: Record<string, string[]> = {
  waiting: ["running", "done", "error", "skipped"],
  running: ["done", "error", "waiting", "skipped"],
  error: ["waiting", "running", "skipped"],
  skipped: ["waiting", "running"],
  done: [],
};

const ISO_Z = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

// Applies one `node update` to the run. Returns the batch summary text.
export function applyUpdate(run: RunState, a: UpdateArgs, ctx: Ctx): string {
  requireNode(run, a.id);
  if (a.status && !NODE_STATUSES.includes(a.status)) fail(`node update: status must be one of: ${NODE_STATUSES.join(" ")}`);
  const deps = a.depsSet ? depsCheck(run, ctx, a.id, a.deps) : "";
  if (!a.status) {
    depsBlock(run, a, deps, ctx);
    return `update ${a.id}`;
  }
  const n = requireNode(run, a.id);
  const old = String(n.status ?? "");
  if (old !== a.status && !a.force) {
    const allowed = ALLOWED[old] ?? NODE_STATUSES;
    if (!allowed.includes(a.status)) {
      fail(
        `node update: ${a.id} is ${old}; it can move to: ${allowed.join(" ") || "nothing"}` +
          (old === "done" ? " (done -> waiting needs --force)" : " (--force overrides)"),
      );
    }
  }
  if (a.job && !a.force && !isDir(join(paths.jobs(ctx.home), a.job))) {
    fail(`node update: job ${a.job} not found (--force records it anyway)`);
  }
  if (a.at) {
    if (!ISO_Z.test(a.at)) fail("node update: --at must be an ISO time like 2026-01-02T03:04:05Z");
    const epoch = epochOf(a.at);
    if (epoch === null) fail("node update: --at is not a valid time");
    if (epoch > (epochOf(ctx.now) ?? 0)) fail("node update: --at is in the future");
  }
  if (a.status === "skipped" && a.force && !a.reason) fail(`node update: skipping with --force needs --reason "<why>"`);
  let status = a.status;
  if (n.id === "done-gate" && n.rerun === true && old === "running") {
    // A node was added while the gate ran: its verify predates that node, so the gate waits again.
    n.rerun = false;
    if (status === "done") status = "waiting";
  }
  setStatus(run, a.id, status, a.job, a.err, a.at, a.owner, ctx);
  if (status !== a.status) ev(ctx, "note", a.id, "", "", "a node was added during the gate: gate waits again");
  if (a.status === "skipped" && a.reason) n.skip_reason = a.reason;
  else if (old === "skipped" && a.status !== "skipped") n.skip_reason = null;
  if (status === "done" && old !== "done") {
    if (ctx.batch) ctx.verify.push(a.id);
    else doneVerify(run, a.id, ctx);
  }
  if (a.depsSet || a.needsSet || a.holdSet) depsBlock(run, a, deps, ctx);
  return `update ${a.id} -> ${status}`;
}

// ---- report --------------------------------------------------------------------------------------

export interface ReportArgs {
  id: string;
  model: string;
  inTok: string;
  outTok: string;
  cacheTok: string;
  usd: string;
  note: string;
}

export function parseReportArgs(args: string[]): ReportArgs {
  const a: ReportArgs = { id: args[0] ?? "", model: "", inTok: "", outTok: "", cacheTok: "", usd: "", note: "" };
  let i = 1;
  while (i < args.length) {
    const k = args[i];
    const v = nextValue(args, i);
    switch (k) {
      case "--model": a.model = v; break;
      case "--input-tokens": a.inTok = v; break;
      case "--output-tokens": a.outTok = v; break;
      case "--cache-read-tokens": a.cacheTok = v; break;
      case "--usd": a.usd = v; break;
      case "--note": a.note = v; break;
      default: fail(`node report: unknown argument ${k}\n  usage: ${USAGE.report}`);
    }
    i += 2;
  }
  for (const t of [a.inTok, a.outTok, a.cacheTok]) {
    if (t && !isUint(t)) fail("node report: token counts must be whole numbers");
  }
  if (a.usd && (/[^0-9.]/.test(a.usd) || (a.usd.match(/\./g) ?? []).length >= 2 || a.usd === ".")) {
    fail("node report: --usd must be a non-negative number");
  }
  if (!a.model && !a.inTok && !a.outTok && !a.cacheTok && !a.usd && !a.note) {
    fail(`node report: nothing to record\n  usage: ${USAGE.report}`);
  }
  return a;
}

const INLINE_AUTO = ["input_tokens", "output_tokens", "cache_read_tokens", "usd"];

export function applyReport(run: RunState, a: ReportArgs, ctx: Ctx): string {
  const n = requireNode(run, a.id);
  const o: Record<string, any> = n.report ?? {};
  if (a.model) n.model = a.model;
  const tok = (given: string, prev: unknown) => (given === "" ? prev ?? null : Number(given));
  const prevAuto: string[] =
    ["owner-fill", "owner-liveness"].includes(o.reported_by ?? "")
      ? INLINE_AUTO.filter((k) => o[k] != null)
      : o.auto ?? [];
  const given: Record<string, string> = {
    input_tokens: a.inTok,
    output_tokens: a.outTok,
    cache_read_tokens: a.cacheTok,
    usd: a.usd,
  };
  const auto = prevAuto.filter((k) => !given[k]);
  n.report = {
    reported_by: "inline",
    model: a.model === "" ? o.model ?? null : a.model,
    input_tokens: tok(a.inTok, o.input_tokens),
    output_tokens: tok(a.outTok, o.output_tokens),
    cache_read_tokens: tok(a.cacheTok, o.cache_read_tokens),
    usd: a.usd === "" ? o.usd ?? null : Number(a.usd),
    note: a.note === "" ? o.note ?? null : a.note,
    at: ctx.now,
    auto: auto.length === 0 ? null : auto,
  };
  n.updated = ctx.now;
  if (a.note) ev(ctx, "note", a.id, "", "", a.note);
  return `report ${a.id}`;
}

// Trims the way batch.sh trimnl does: newlines to spaces, trailing spaces off.
export function trimnl(msg: string): string {
  return msg.replace(/\n/g, " ").replace(/ +$/, "");
}
