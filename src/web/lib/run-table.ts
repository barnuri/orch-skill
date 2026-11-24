import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { nodeUsage } from "../../shared/run-usage";
import { fmtTokens, fmtUsd } from "./format";
import { exactOwner, holdReason, needsUserReason, nodeFlags, ownerText } from "./node-flags";
import { durationMetric, waitingOnDeps } from "./node-metrics";
import { iconModelOf, familyOf, type ModelFamily } from "./model-family";
import { nodeModel, type NodeFilter, matchesFilter } from "../runs/run-filter";

export type RunView = "graph" | "table";
export const RUN_VIEW_KEY = "orch.graph.view";
export const RUN_COLS_KEY = "orch.graph.cols";
type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function store(): PrefStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadRunView(storage: PrefStorage | null = store()): RunView {
  try {
    return storage?.getItem(RUN_VIEW_KEY) === "table" ? "table" : "graph";
  } catch {
    return "graph";
  }
}

export function saveRunView(view: RunView, storage: PrefStorage | null = store()): void {
  try {
    storage?.setItem(RUN_VIEW_KEY, view);
  } catch {
    // A blocked localStorage must not break the switch.
  }
}

/** `?view=table` of a run hash, or null when absent (then the saved preference applies). */
export function parseViewParam(hash: string): RunView | null {
  const cut = hash.indexOf("?");
  const value = cut < 0 ? null : new URLSearchParams(hash.slice(cut + 1)).get("view");
  return value === "table" || value === "graph" ? value : null;
}

export interface ColumnDef {
  key: string;
  label: string;
  /** Hidden on a phone by default. */
  wide?: boolean;
  defaultOn: boolean;
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: "status", label: "Status", defaultOn: true },
  { key: "id", label: "Node", defaultOn: true },
  { key: "result", label: "Result", defaultOn: true },
  { key: "role", label: "Role", defaultOn: false, wide: true },
  { key: "tier", label: "Tier", defaultOn: false, wide: true },
  { key: "profile", label: "Profile", defaultOn: true, wide: true },
  { key: "model", label: "Model", defaultOn: true, wide: true },
  { key: "owner", label: "Owner", defaultOn: false, wide: true },
  { key: "waiting", label: "Waiting on / needs you", defaultOn: true },
  { key: "warn", label: "Warnings", defaultOn: true },
  { key: "started", label: "Started", defaultOn: false, wide: true },
  { key: "duration", label: "Duration", defaultOn: true },
  { key: "activity", label: "Last activity", defaultOn: true, wide: true },
  { key: "attempts", label: "Attempts", defaultOn: false, wide: true },
  { key: "tokens", label: "Tokens", defaultOn: false, wide: true },
  { key: "cost", label: "Cost", defaultOn: true, wide: true },
  { key: "ctx", label: "Peak ctx", defaultOn: false, wide: true },
  { key: "handoff", label: "Handoff", defaultOn: false, wide: true },
];

export const DEFAULT_COLS: readonly string[] = COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);

export function loadCols(storage: PrefStorage | null = store()): string[] {
  try {
    const raw = storage?.getItem(RUN_COLS_KEY);
    if (raw === null || raw === undefined) {
      return [...DEFAULT_COLS];
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const keys = parsed.filter((k): k is string => typeof k === "string" && COLUMNS.some((c) => c.key === k));
      return keys.length === 0 ? [...DEFAULT_COLS] : keys;
    }
  } catch {
    // fall through to defaults
  }
  return [...DEFAULT_COLS];
}

export function saveCols(cols: readonly string[], storage: PrefStorage | null = store()): void {
  try {
    storage?.setItem(RUN_COLS_KEY, JSON.stringify(cols));
  } catch {
    // ignore
  }
}

/** Run-level fields the coordinator row reads; `coordinator` is written by the server but absent from RunState. */
export type RunWithCoordinator = RunState & { coordinator?: { session_id?: string; harness?: string; at?: string } | null };

export type MainStatus = "running" | "idle" | "unreachable";

/** One inline warning of a node row. `status` picks the chip colour class (Chip). */
export interface RowWarning {
  key: string;
  status: "error" | "waiting" | "stale" | "unowned";
  text: string;
}

/** The warnings of a node row, most urgent first: error, needs you, held, stale, unowned. Empty when none apply. */
export function rowWarnings(node: RunNode): RowWarning[] {
  const out: RowWarning[] = [];
  if (node.status === "error") {
    out.push({ key: "error", status: "error", text: node.error?.trim() || "failed" });
  }
  const needs = needsUserReason(node);
  if (needs !== null) {
    out.push({ key: "needs", status: "waiting", text: `needs you: ${needs}` });
  }
  const hold = holdReason(node);
  if (hold !== null) {
    out.push({ key: "hold", status: "waiting", text: `held: ${hold}` });
  }
  const flags = nodeFlags(node);
  if (flags.stale) {
    out.push({ key: "stale", status: "stale", text: "stale: no activity from the owner" });
  }
  if (flags.unowned) {
    out.push({ key: "unowned", status: "unowned", text: "unowned: no owner or job recorded" });
  }
  return out;
}

export interface TableRow {
  kind: "main" | "node";
  warnings: RowWarning[];
  runId: string;
  id: string;
  node: RunNode | null;
  status: string;
  /** Node id (or session id for the main row). */
  idText: string;
  goal: string;
  verdict: string;
  summary: string;
  role: string;
  tier: string;
  profile: string;
  model: string;
  family: ModelFamily;
  owner: string;
  waiting: string;
  startedMs: number | null;
  durationMs: number | null;
  durationText: string;
  activityMs: number | null;
  attempts: number | null;
  tokens: number | null;
  cost: number | null;
  ctx: number | null;
  handoff: boolean | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined || iso === "") {
    return null;
  }
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function mainStatus(run: RunWithCoordinator): MainStatus {
  const state = run.orchestrator_state ?? run.coordinator_state;
  if (state !== null && state !== undefined && !state.reachable) {
    return "unreachable";
  }
  return run.status === "running" && run.paused !== true && run.stopped !== true ? "running" : "idle";
}

export function mainRow(run: RunWithCoordinator): TableRow {
  const state = run.orchestrator_state ?? run.coordinator_state;
  const session = run.coordinator?.session_id ?? run.harness_session;
  const harness = run.coordinator?.harness ?? "";
  const status = mainStatus(run);
  return {
    kind: "main", runId: run.run_id, id: "__main__", node: null, status,
    idText: session === "" ? "main session" : session,
    goal: "Orch main session (orchestrator)",
    verdict: "", summary: "", role: "orchestrator", tier: "", profile: harness, model: "", family: "fallback",
    owner: "", waiting: state === null || state === undefined ? "" : `${state.pending_asks} pending orchestrator question${state.pending_asks === 1 ? "" : "s"}`,
    startedMs: ms(run.started), durationMs: null, durationText: "—",
    activityMs: ms(run.coordinator?.at), attempts: null, tokens: null, cost: null, ctx: null, handoff: null,
    warnings: [],
  };
}

export function nodeRow(run: RunState, node: RunNode, nowMs: number, harnessByProfile: Readonly<Record<string, string>>): TableRow {
  const usage = nodeUsage(node);
  const dur = durationMetric(node, run, nowMs);
  const waitDeps = waitingOnDeps(run, node.id);
  const needs = needsUserReason(node);
  const hold = holdReason(node);
  const waiting = node.status === "waiting" ? (waitDeps.length > 0 ? `waiting on ${waitDeps.join(", ")}` : (needs !== null ? `needs you: ${needs}` : hold !== null ? `held: ${hold}` : "ready")) : needs !== null ? `needs you: ${needs}` : "";
  const model = node.actual_model ?? nodeModel(node);
  const start = ms(node.started_at ?? node.started);
  const end = ms(node.finished_at ?? node.finished);
  return {
    kind: "node", runId: run.run_id, id: node.id, node, status: node.status,
    warnings: rowWarnings(node),
    idText: node.id,
    goal: (node.label.split("\n")[0] ?? "").trim(),
    verdict: node.result?.verdict ?? "", summary: node.result?.summary ?? "",
    role: node.role ?? "", tier: node.tier ?? "",
    profile: node.profile ?? node.adapter ?? harnessByProfile[node.profile ?? ""] ?? "",
    model, family: familyOf(model !== "" ? model : iconModelOf(node)),
    owner: [ownerText(node), node.owner_state != null ? exactOwner(node) : null].filter((x) => x != null && x !== "").join(" · "), waiting,
    startedMs: start,
    durationMs: start === null ? null : (end ?? nowMs) - start,
    durationText: dur.text,
    activityMs: ms(node.last_activity ?? node.updated),
    attempts: (node.attempts?.length ?? 0) + 1,
    tokens: usage.tokens, cost: usage.usd,
    ctx: node.session_stats?.peak_context ?? null,
    handoff: node.handoff_present ?? null,
  };
}

/** The node ids both views show: the filter, the Hide done toggle, and the selected node (always kept). */
export function visibleNodes(run: RunState, filter: NodeFilter, harnessByProfile: Readonly<Record<string, string>>, hideDone: boolean, selectedId: string | null, active: boolean): RunNode[] {
  return run.nodes.filter(
    (node) => node.id === selectedId || ((!hideDone || (node.status !== "done" && node.status !== "skipped" && node.status !== "covered")) && (!active || matchesFilter(run, node, filter, harnessByProfile))),
  );
}

export interface Sort {
  key: string;
  dir: "asc" | "desc";
}

const SORT_VALUE: Record<string, (r: TableRow) => string | number | null> = {
  status: (r) => r.status, id: (r) => r.idText, result: (r) => r.verdict, role: (r) => r.role, tier: (r) => r.tier,
  profile: (r) => r.profile, model: (r) => r.model, owner: (r) => r.owner, waiting: (r) => r.waiting,
  started: (r) => r.startedMs, duration: (r) => r.durationMs, activity: (r) => r.activityMs, attempts: (r) => r.attempts,
  tokens: (r) => r.tokens, cost: (r) => r.cost, ctx: (r) => r.ctx, handoff: (r) => (r.handoff === null ? null : r.handoff ? 1 : 0),
};

/** Sorts node rows (missing values last in both directions) and always pins the main row first. */
export function sortRows(rows: readonly TableRow[], sort: Sort | null): TableRow[] {
  const main = rows.filter((r) => r.kind === "main");
  const rest = rows.filter((r) => r.kind === "node");
  const get = sort === null ? undefined : SORT_VALUE[sort.key];
  if (sort !== null && get !== undefined) {
    const sign = sort.dir === "asc" ? 1 : -1;
    rest.sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null && y === null) { return 0; }
      if (x === null) { return 1; }
      if (y === null) { return -1; }
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sign;
    });
  }
  return [...main, ...rest];
}

const EXPORT_HEAD = ["kind", "status", "id", "goal", "verdict", "summary", "role", "tier", "profile", "model", "owner", "waiting", "started", "duration", "last_activity", "attempts", "tokens", "cost_usd", "peak_context", "handoff"];
const iso = (t: number | null): string => (t === null ? "" : new Date(t).toISOString());

function exportCells(r: TableRow): string[] {
  return [r.kind, r.status, r.idText, r.goal, r.verdict, r.summary, r.role, r.tier, r.profile, r.model, r.owner, r.waiting, iso(r.startedMs), r.durationText, iso(r.activityMs), r.attempts === null ? "" : String(r.attempts), r.tokens === null ? "" : String(r.tokens), r.cost === null ? "" : String(r.cost), r.ctx === null ? "" : String(r.ctx), r.handoff === null ? "" : String(r.handoff)];
}

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: readonly TableRow[]): string {
  return [EXPORT_HEAD, ...rows.map(exportCells)].map((line) => line.map(csvCell).join(",")).join("\n") + "\n";
}

export function toMarkdown(rows: readonly TableRow[]): string {
  const cell = (v: string): string => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells: string[]): string => `| ${cells.map(cell).join(" | ")} |`;
  return [line(EXPORT_HEAD), line(EXPORT_HEAD.map(() => "---")), ...rows.map((r) => line(exportCells(r)))].join("\n") + "\n";
}

export const fmtTok = (n: number | null): string => (n === null ? "—" : fmtTokens(n));
export const fmtCost = (n: number | null): string => (n === null ? "—" : fmtUsd(n));

/** Columns shown: the saved pick, else the defaults (minus the wide ones on a phone). */
export function effectiveCols(phone: boolean, storage: PrefStorage | null = store()): string[] {
  let saved = false;
  try {
    saved = storage?.getItem(RUN_COLS_KEY) !== null && storage?.getItem(RUN_COLS_KEY) !== undefined;
  } catch {
    saved = false;
  }
  const cols = loadCols(storage);
  return saved || !phone ? cols : cols.filter((k) => COLUMNS.find((c) => c.key === k)?.wide !== true);
}

/** The same hash with `view=` written into its query part, keeping every other param. */
export function hashWithView(hash: string, view: RunView): string {
  const cut = hash.indexOf("?");
  const base = cut < 0 ? hash : hash.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? "" : hash.slice(cut + 1));
  params.set("view", view);
  return `${base}?${params.toString()}`;
}
