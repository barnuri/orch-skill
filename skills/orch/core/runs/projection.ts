// The canonical run projection: one answer to "what state is this run in". `run status` (CLI), GET
// /api/runs/{id}/projection (API), the auto-dispatch supervisor (decide) and the run page (UI) all read it.
// Nothing else infers effective status, readiness, open requirements, gaps or flags.
//
// Inputs: run state (state.json), the requirement ledger (requirements.json), each node's handoff.md facts
// (out dirs) and the watchdog flags (watchdog/flags.json). `buildRunProjection` is pure: the same input gives
// the same output, and it holds no clock, so CLI and API output are equal for equal state.
//
// Bun-free and dependency-free (the server imports this file too).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../state/store.ts";
import { paths } from "../state/home.ts";
import { loadLedger, REQ_OK } from "../commands/req.ts";

export type NodeState = "ready" | "blocked" | "running" | "done" | "error" | "covered" | "skipped" | (string & {});
export type RequirementBucket = "open" | "in_progress" | "implemented" | "verifying" | "done" | "covered" | "skipped";

export interface ProjectionNodeInput {
  id: string;
  label?: string;
  status: string;
  after_all?: boolean;
  needs_user?: string | null;
  hold?: string | null;
  covered_by?: string | null;
  result?: { verdict?: string } | null;
  job_id?: string | null;
  owner_state?: string | null;
  owner_reason?: string | null;
  unverified?: boolean;
}

export interface ProjectionRunInput {
  run_id: string;
  title?: string;
  status: string;
  needs_user?: string | null;
  paused?: boolean;
  stopped?: boolean;
  edges?: [string, string][];
  nodes: ProjectionNodeInput[];
}

export interface LedgerEvidence { note: string; file: string | null; test: string | null; at: string }
export interface LedgerRequirement { id: string; text?: string; status: string; reason?: string | null; nodes?: string[]; evidence?: LedgerEvidence[] }

/** One line of `<home>/watchdog/flags.json`: a watchdog flag plus the node status it was raised in. */
export interface StoredFlag { run: string; node: string; rule: string; detail: string; at: string; status: string }

export interface ProjectionInput {
  run: ProjectionRunInput;
  requirements: LedgerRequirement[];
  /** node id -> handoff.md exists and is non-empty. */
  handoffs: Record<string, boolean>;
  flags: StoredFlag[];
}

export interface ProjectionNode {
  id: string;
  label: string;
  status: string;
  state: NodeState;
  blocked_by: string[];
  hold: string | null;
  needs_user: string | null;
  handoff: boolean;
  result: boolean;
  unverified: boolean;
}

export interface ProjectionRequirementNode { id: string; status: string; state: NodeState; done: boolean; handoff: boolean; unverified: boolean }

export interface ProjectionRequirement {
  id: string;
  text: string;
  status: string;
  reason: string | null;
  bucket: RequirementBucket;
  /** Closed: handled, superseded or waived. */
  ok: boolean;
  /** Open or partial, and a linked node is blocked or in error. */
  blocked: boolean;
  nodes: ProjectionRequirementNode[];
  evidence: LedgerEvidence[];
}

export interface HandoffGap { node: string; reason: "missing_handoff" }
export interface OwnerDiagnostic { node: string; job_id: string | null; owner_state: string | null; owner_reason: string | null; diagnosis: "ok" | "unowned" | string }
export interface SupervisorFlag { node: string; rule: string; detail: string; at: string }
export interface NextAction {
  kind: "resume_run" | "answer_question" | "fix_error" | "record_handoff" | "record_result" | "close_requirement" | "start_node" | "review_flag" | "finish_run";
  node: string | null;
  requirement: string | null;
  text: string;
}

export interface RunProjection {
  run_id: string;
  /** Effective status: `stopped` or `paused` when set, else the run's own status. */
  status: string;
  raw_status: string;
  counts: {
    nodes: Record<string, number>;
    requirements: Record<RequirementBucket | "total" | "blocked", number>;
  };
  nodes: ProjectionNode[];
  requirements: ProjectionRequirement[];
  /** Ids of requirements in bucket open. */
  open_requirements: string[];
  /** Ids of requirements in bucket in_progress. */
  partials: string[];
  handoff_gaps: HandoffGap[];
  ready: string[];
  blocked: string[];
  covered: string[];
  skipped: string[];
  /** `paused` or `stopped` when the run gate stops every start, else null. */
  run_gate: "paused" | "stopped" | null;
  next_actions: NextAction[];
  owners: OwnerDiagnostic[];
  supervisor: { flags: SupervisorFlag[] };
}

const BUCKET: Record<string, RequirementBucket> = { open: "open", not: "open", in_progress: "in_progress", partly: "in_progress", implemented: "implemented", verifying: "verifying", done: "done", handled: "done", superseded: "covered", waived: "skipped" };
const BUCKETS: RequirementBucket[] = ["open", "in_progress", "implemented", "verifying", "done", "covered", "skipped"];

/** Whether a dependency is met: done or skipped, or covered by a done replacement. */
export function nodeSatisfied(run: { nodes: ProjectionNodeInput[] }, n: ProjectionNodeInput): boolean {
  if (n.status === "done" || n.status === "skipped") return true;
  if (n.status !== "covered") return false;
  const ref = String(n.covered_by ?? "");
  const target = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
  return run.nodes.some((m) => m.id === target && m.status === "done");
}

/**
 * Unmet dependencies of a waiting node: unsatisfied edge sources and, for an `after_all` node, every other
 * node that is not `after_all`. `settled(id)` is false for a done dependency the watchdog may still flip,
 * which then counts as unmet. Empty when the node may start.
 */
export function blockersOf(run: { nodes: ProjectionNodeInput[]; edges?: [string, string][] }, x: ProjectionNodeInput, settled: (id: string) => boolean = () => true): string[] {
  const met = (n: ProjectionNodeInput): boolean => nodeSatisfied(run, n) && (n.status !== "done" || settled(n.id));
  const out: string[] = [];
  for (const [src, dst] of run.edges ?? []) {
    if (dst !== x.id) continue;
    const s = run.nodes.find((n) => n.id === src);
    if (s && !met(s) && !out.includes(src)) out.push(src);
  }
  if (x.after_all === true) {
    for (const n of run.nodes) {
      if (n.id === x.id || n.after_all === true) continue;
      if (!met(n) && !out.includes(n.id)) out.push(n.id);
    }
  }
  return out;
}

/** Whether a flag's cause is gone: its node is missing, left the status it was raised in, or an unverified node now has its handoff. */
export function flagCleared(flag: { rule: string; status: string }, node: { status: string } | undefined, handoffHere: boolean): boolean {
  return node === undefined || node.status !== flag.status || (flag.rule === "unverified" && handoffHere);
}

/** The flags that still stand for a run: only while the run is running, and only those whose cause is still there. */
export function activeFlags(flags: StoredFlag[], run: ProjectionRunInput, handoffs: Record<string, boolean>): StoredFlag[] {
  if (run.status !== "running") return [];
  return flags.filter((f) => f.run === run.run_id && !flagCleared(f, run.nodes.find((n) => n.id === f.node), handoffs[f.node] === true));
}

function nodeStateOf(run: ProjectionRunInput, n: ProjectionNodeInput): { state: NodeState; blocked_by: string[] } {
  if (n.status !== "waiting") return { state: n.status, blocked_by: [] };
  const deps = blockersOf(run, n);
  const gated = (n.needs_user ?? "") !== "" || (n.hold ?? "") !== "";
  return { state: deps.length > 0 || gated ? "blocked" : "ready", blocked_by: deps };
}

/** Builds the projection from its inputs. Pure: no clock, no I/O. */
export function buildRunProjection(input: ProjectionInput): RunProjection {
  const run = input.run;
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const rawGate: "paused" | "stopped" | null = run.stopped === true ? "stopped" : run.paused === true ? "paused" : null;

  const nodes: ProjectionNode[] = run.nodes.map((n) => {
    const { state, blocked_by } = nodeStateOf(run, n);
    return {
      id: n.id,
      label: n.label ?? "",
      status: n.status,
      state,
      blocked_by,
      hold: (n.hold ?? "") === "" ? null : String(n.hold),
      needs_user: (n.needs_user ?? "") === "" ? null : String(n.needs_user),
      handoff: input.handoffs[n.id] === true,
      result: Boolean(n.result),
      unverified: n.unverified === true,
    };
  });
  const stateOf = new Map(nodes.map((n) => [n.id, n]));

  const requirements: ProjectionRequirement[] = input.requirements.map((r) => {
    const status = String(r.status ?? "open");
    const linked = (r.nodes ?? []).map((id) => {
      const n = byId.get(id);
      const state = n === undefined ? "missing" : stateOf.get(id)!.state;
      return { id, status: n?.status ?? "missing", state, done: n?.status === "done", handoff: input.handoffs[id] === true, unverified: n?.unverified === true };
    });
    const ok = REQ_OK.includes(status);
    const bucket = BUCKET[status] ?? "open";
    return {
      id: String(r.id),
      text: String(r.text ?? ""),
      status,
      reason: (r.reason ?? null) === null ? null : String(r.reason),
      bucket,
      ok,
      blocked: !ok && linked.some((n) => n.state === "blocked" || n.state === "error" || n.state === "missing"),
      nodes: linked,
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
    };
  });

  const ids = (pred: (n: ProjectionNode) => boolean): string[] => nodes.filter(pred).map((n) => n.id);
  const nodeCounts: Record<string, number> = {};
  for (const n of nodes) nodeCounts[n.state] = (nodeCounts[n.state] ?? 0) + 1;
  nodeCounts.total = nodes.length;
  const reqCounts = { total: requirements.length, blocked: requirements.filter((r) => r.blocked).length } as Record<RequirementBucket | "total" | "blocked", number>;
  for (const b of BUCKETS) reqCounts[b] = requirements.filter((r) => r.bucket === b).length;

  const handoffGaps: HandoffGap[] = nodes.filter((n) => n.status === "done" && !n.handoff).map((n) => ({ node: n.id, reason: "missing_handoff" as const }));
  const ready = ids((n) => n.state === "ready");
  const flags: SupervisorFlag[] = activeFlags(input.flags, run, input.handoffs).map((f) => ({ node: f.node, rule: f.rule, detail: f.detail, at: f.at }));
  const owners: OwnerDiagnostic[] = run.nodes
    .filter((n) => n.status === "running")
    .map((n) => ({
      node: n.id,
      job_id: n.job_id ?? null,
      owner_state: (n.owner_state ?? "") === "" ? null : String(n.owner_state),
      owner_reason: (n.owner_reason ?? "") === "" ? null : String(n.owner_reason),
      diagnosis: (n.owner_state ?? "") !== "" ? String(n.owner_state) : (n.job_id ?? "") !== "" ? "ok" : "unowned",
    }));

  const next: NextAction[] = [];
  if (rawGate !== null) next.push({ kind: "resume_run", node: null, requirement: null, text: `run ${rawGate}: resume it to start nodes` });
  for (const n of run.nodes) {
    if ((n.needs_user ?? "") !== "") next.push({ kind: "answer_question", node: n.id, requirement: null, text: `answer ${n.id}: ${String(n.needs_user)}` });
  }
  for (const n of run.nodes) {
    if (n.status === "error" && !run.nodes.some((m) => m.status === "covered" && String(m.covered_by ?? "").endsWith(`/${n.id}`))) {
      next.push({ kind: "fix_error", node: n.id, requirement: null, text: `fix ${n.id}: error` });
    }
  }
  for (const g of handoffGaps) next.push({ kind: "record_handoff", node: g.node, requirement: null, text: `write handoff.md for ${g.node}` });
  for (const n of nodes) {
    const raw = byId.get(n.id);
    if (n.status === "done" && (!raw?.result || raw.result.verdict === "unknown")) next.push({ kind: "record_result", node: n.id, requirement: null, text: `record a result for ${n.id}` });
  }
  for (const r of requirements.filter((x) => x.bucket === "open" || x.bucket === "in_progress")) {
    next.push({ kind: "close_requirement", node: null, requirement: r.id, text: `${r.bucket === "in_progress" ? "finish" : "handle"} requirement ${r.id}` });
  }
  for (const r of requirements.filter((x) => x.bucket === "implemented")) {
    next.push({ kind: "close_requirement", node: null, requirement: r.id, text: `get requirement ${r.id} verified by another node` });
  }
  for (const f of flags) next.push({ kind: "review_flag", node: f.node, requirement: null, text: `watchdog ${f.rule} on ${f.node}: ${f.detail}` });
  if (run.status === "running" && typeof run.needs_user === "string" && run.needs_user !== "") next.push({ kind: "answer_question", node: null, requirement: null, text: `run verify failed: ${run.needs_user.split("\n")[0]}` });
  const settled = run.nodes.length > 0 && run.nodes.every((n) => n.status === "done" || n.status === "skipped" || n.status === "covered");
  if (settled && run.status === "running" && rawGate === null) next.push({ kind: "finish_run", node: null, requirement: null, text: "All nodes settled: verify requirements and finish the run" });
  if (rawGate === null) for (const id of ready) next.push({ kind: "start_node", node: id, requirement: null, text: `start ${id}` });

  // A finished run (done or cancelled) has nothing to start and nothing to do next.
  const finished = run.status === "done" || run.status === "cancelled";
  if (finished) next.length = 0;

  return {
    run_id: run.run_id,
    status: rawGate === "stopped" ? "stopped" : rawGate === "paused" ? "paused" : run.status,
    raw_status: run.status,
    counts: { nodes: nodeCounts, requirements: reqCounts },
    nodes,
    requirements,
    open_requirements: requirements.filter((r) => r.bucket === "open").map((r) => r.id),
    partials: requirements.filter((r) => r.bucket === "in_progress").map((r) => r.id),
    handoff_gaps: handoffGaps,
    ready: rawGate === null && !finished ? ready : [],
    blocked: ids((n) => n.state === "blocked"),
    covered: ids((n) => n.state === "covered"),
    skipped: ids((n) => n.state === "skipped"),
    run_gate: rawGate,
    next_actions: next,
    owners,
    supervisor: { flags },
  };
}

// ---- Loading from a state home (the only I/O) ----

export function flagsFile(home: string): string {
  return join(home, "watchdog", "flags.json");
}

/** Writes the watchdog's flags atomically (`flags.json.tmp` then rename). Server-written, like the claim files. */
export function writeFlags(home: string, flags: StoredFlag[]): void {
  const file = flagsFile(home);
  mkdirSync(join(home, "watchdog"), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(flags, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export function readFlags(home: string): StoredFlag[] {
  const file = flagsFile(home);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function handoffHas(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** The projection of one run read from its state home, or null when the run does not exist. */
export async function loadRunProjection(home: string, runId: string): Promise<RunProjection | null> {
  const state = await loadRun(home, runId);
  if (!state) return null;
  const nodes = (state.nodes ?? []) as unknown as ProjectionNodeInput[];
  const handoffs: Record<string, boolean> = {};
  for (const n of nodes) {
    const dir = typeof (n as { out_dir?: unknown }).out_dir === "string" && (n as { out_dir?: string }).out_dir !== "" ? String((n as { out_dir?: string }).out_dir) : paths.runOutDir(home, runId, n.id);
    handoffs[n.id] = handoffHas(join(dir, "handoff.md"));
  }
  const ledger = await loadLedger(home, runId);
  return buildRunProjection({
    run: { run_id: runId, title: state.title, status: state.status, paused: state.paused, stopped: state.stopped, edges: state.edges ?? [], nodes },
    requirements: ledger.requirements as LedgerRequirement[],
    handoffs,
    flags: readFlags(home),
  });
}
