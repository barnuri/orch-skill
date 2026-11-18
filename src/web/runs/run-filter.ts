import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";

/** What the run summary counts. A held waiting node and a running node of a paused run are "paused". */
export const SUMMARY_BUCKETS = ["done", "running", "waiting", "paused", "error", "skipped"] as const;
export type SummaryBucket = (typeof SUMMARY_BUCKETS)[number];

export function nodeBucket(run: RunState, node: RunNode): SummaryBucket {
  if (node.status === "running") {
    return run.paused === true ? "paused" : "running";
  }
  if (node.status === "waiting") {
    return (node.hold ?? "") !== "" || run.paused === true ? "paused" : "waiting";
  }
  return node.status;
}

export type RunSummary = Record<SummaryBucket, number> & { total: number };

export function runSummary(run: RunState): RunSummary {
  const out: RunSummary = { total: run.nodes.length, done: 0, running: 0, waiting: 0, paused: 0, error: 0, skipped: 0 };
  for (const node of run.nodes) {
    out[nodeBucket(run, node)] += 1;
  }
  return out;
}

export interface NodeFilter {
  status: SummaryBucket | "";
  /** Matches the node's profile or its harness (adapter, or the profile's harness). */
  profile: string;
  model: string;
  /** Free text over label and id, case-insensitive. */
  q: string;
  /** The node's recorded result verdict; a node with no result counts as "unknown". */
  verdict: Verdict | "";
}

export const VERDICTS = ["full", "partial", "blocked", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const EMPTY_FILTER: NodeFilter = { status: "", profile: "", model: "", q: "", verdict: "" };

export function isFilterActive(filter: NodeFilter): boolean {
  return filter.status !== "" || filter.profile !== "" || filter.model !== "" || filter.q.trim() !== "" || filter.verdict !== "";
}

export function nodeModel(node: RunNode): string {
  return node.actual_model ?? node.main_model ?? node.model ?? "";
}

export function nodeHarness(node: RunNode, harnessByProfile: Readonly<Record<string, string>>): string {
  return node.adapter ?? (node.profile === null ? "" : (harnessByProfile[node.profile] ?? ""));
}

export function matchesFilter(run: RunState, node: RunNode, filter: NodeFilter, harnessByProfile: Readonly<Record<string, string>>): boolean {
  if (filter.status !== "" && nodeBucket(run, node) !== filter.status) {
    return false;
  }
  if (filter.profile !== "" && node.profile !== filter.profile && nodeHarness(node, harnessByProfile) !== filter.profile) {
    return false;
  }
  if (filter.model !== "" && nodeModel(node) !== filter.model) {
    return false;
  }
  if (filter.verdict !== "" && (node.result?.verdict ?? "unknown") !== filter.verdict) {
    return false;
  }
  const q = filter.q.trim().toLowerCase();
  return q === "" || node.id.toLowerCase().includes(q) || node.label.toLowerCase().includes(q);
}

/** The distinct profiles, harnesses and models of a run, sorted, for the filter pickers. */
export function filterOptions(run: RunState, harnessByProfile: Readonly<Record<string, string>>): { profiles: string[]; models: string[] } {
  const profiles = new Set<string>();
  const models = new Set<string>();
  for (const node of run.nodes) {
    if (node.profile !== null && node.profile !== "") {
      profiles.add(node.profile);
    }
    const harness = nodeHarness(node, harnessByProfile);
    if (harness !== "") {
      profiles.add(harness);
    }
    const model = nodeModel(node);
    if (model !== "") {
      models.add(model);
    }
  }
  return { profiles: [...profiles].sort(), models: [...models].sort() };
}

const isBucket = (value: string): value is SummaryBucket => (SUMMARY_BUCKETS as readonly string[]).includes(value);

/** Reads the filter from the query part of a run hash: `#/run/<id>?status=error&q=build`. */
export function parseFilter(hash: string): NodeFilter {
  const cut = hash.indexOf("?");
  if (cut < 0) {
    return EMPTY_FILTER;
  }
  const params = new URLSearchParams(hash.slice(cut + 1));
  const status = params.get("status") ?? "";
  return {
    status: isBucket(status) ? status : "",
    profile: params.get("profile") ?? "",
    model: params.get("model") ?? "",
    q: params.get("q") ?? "",
    verdict: (VERDICTS as readonly string[]).includes(params.get("verdict") ?? "") ? (params.get("verdict") as Verdict) : "",
  };
}

/** The same hash with the filter written into its query part (dropped when the filter is empty). */
export function hashWithFilter(hash: string, filter: NodeFilter): string {
  const cut = hash.indexOf("?");
  const base = cut < 0 ? hash : hash.slice(0, cut);
  const params = new URLSearchParams();
  // The view switch shares the hash query and survives a filter change.
  const view = cut < 0 ? null : new URLSearchParams(hash.slice(cut + 1)).get("view");
  if (view !== null) {
    params.set("view", view);
  }
  for (const key of ["status", "profile", "model", "q", "verdict"] as const) {
    if (filter[key] !== "") {
      params.set(key, filter[key]);
    }
  }
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}
