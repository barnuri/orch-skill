import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { NODE_STATUSES } from "../../shared/types/node-status";
import type { NodeStatus } from "../../shared/types/node-status";
import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";
import { runUsage } from "../../shared/run-usage";
import type { OrchPaths } from "../types/orch-paths";
import { annotateActivity } from "./node-activity";
import { timingSummary } from "../../shared/node-timing";
import { isRunId } from "./run-id";

/** Adds the computed `timing` (phase, run and wait seconds) to every node, in place. */
export function annotateTiming(run: RunState, nowMs: number = Date.now()): void {
  for (const node of run.nodes ?? []) {
    node.timing = timingSummary(node, run, nowMs);
  }
}

const STATE_FILE: string = "state.json";
const MISSING_FILE_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];

export type RunReadResult =
  | { kind: "ok"; run: RunState }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string };

/** `null` = no state.json at all; `ok: false` = it exists but cannot be used. */
type LoadedState = { ok: true; state: RunState } | { ok: false; reason: string } | null;

function isMissingFileError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof err.code === "string" &&
    MISSING_FILE_CODES.includes(err.code)
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === "string" && (NODE_STATUSES as readonly string[]).includes(value);
}

function parseState(text: string): LoadedState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "state.json is not a JSON object" };
  }
  if (!Array.isArray((value as { nodes?: unknown }).nodes)) {
    return { ok: false, reason: "nodes is not an array" };
  }
  // The CLI is the only writer of state.json; past the shape checks above it is trusted as-is.
  return { ok: true, state: value as RunState };
}

function loadState(runDir: string): LoadedState {
  let text: string;
  try {
    text = readFileSync(join(runDir, STATE_FILE), "utf8");
  } catch (err) {
    if (isMissingFileError(err)) {
      return null;
    }
    return { ok: false, reason: errorMessage(err) };
  }
  return parseState(text);
}

/** Mirrors the old jq `cnt(s)`: only the known statuses are counted, anything else is ignored. */
function countNodes(run: RunState): Record<NodeStatus, number> {
  const counts: Record<NodeStatus, number> = {
    waiting: 0,
    running: 0,
    done: 0,
    error: 0,
    skipped: 0,
  };
  for (const node of run.nodes) {
    const status: unknown = node?.status;
    if (isNodeStatus(status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

function newestActivity(run: RunState): string | null {
  let best: number | null = null;
  for (const node of run.nodes) {
    for (const value of [node?.last_activity, node?.updated, node?.finished, node?.started]) {
      const t = typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (!Number.isNaN(t) && (best === null || t > best)) {
        best = t;
      }
    }
  }
  return best === null ? null : new Date(best).toISOString();
}

function summarize(paths: OrchPaths, run: RunState): RunSummary {
  annotateActivity(paths, run);
  const usage = runUsage(run.nodes);
  const stale = run.nodes.filter((node) => node?.status === "running" && node.stale === true).length;
  const updated = newestActivity(run);
  return {
    run_id: run.run_id,
    title: run.title,
    status: run.status,
    started: run.started,
    finished: run.finished,
    harness_session: run.harness_session,
    counts: countNodes(run),
    // Left out of the JSON when no node reported it, so a summary without usage stays as it was.
    ...(usage.usd === null ? {} : { usd: usage.usd }),
    ...(usage.tokens === null ? {} : { tokens: usage.tokens }),
    ...(stale === 0 ? {} : { stale }),
    ...(updated === null ? {} : { updated }),
    ...(run.status === "covered" && run.covered_by ? {
      covered_by: run.covered_by,
      ...(run.covered_note ? { covered_note: run.covered_note } : {}),
      covered_nodes: run.covered_nodes ?? [],
      covered_map: run.covered_map ?? {},
    } : {}),
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function readRunEntries(runsDir: string): Dirent[] {
  try {
    return readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    if (isMissingFileError(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Every `runs/<id>/state.json` as a `RunSummary`, newest `started` first. Entries that are not a
 * valid run id, not a real directory (symlinks included — `isDirectory()` is false for them), or
 * have no state.json yet are skipped quietly; an unusable state.json is skipped with a stderr line.
 */
export function listRuns(paths: OrchPaths): RunSummary[] {
  const entries = readRunEntries(paths.runs).sort((a, b) => compareStrings(a.name, b.name));
  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    if (!isRunId(entry.name) || !entry.isDirectory()) {
      continue;
    }
    const loaded = loadState(join(paths.runs, entry.name));
    if (loaded === null) {
      continue;
    }
    if (!loaded.ok) {
      console.error(`runs: skipping ${entry.name}: ${loaded.reason}`);
      continue;
    }
    summaries.push(summarize(paths, loaded.state));
  }
  // Same as the old jq `sort_by(.started) | reverse`: a stable ascending sort, then reversed.
  return summaries.sort((a, b) => compareStrings(a.started, b.started)).reverse();
}

export function readRun(paths: OrchPaths, id: string): RunReadResult {
  if (!isRunId(id)) {
    return { kind: "missing" };
  }
  const loaded = loadState(join(paths.runs, id));
  if (loaded === null) {
    return { kind: "missing" };
  }
  if (!loaded.ok) {
    return { kind: "corrupt", reason: loaded.reason };
  }
  annotateActivity(paths, loaded.state);
  annotateTiming(loaded.state);
  return { kind: "ok", run: loaded.state };
}
