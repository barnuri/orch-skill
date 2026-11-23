import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    "blocked-user": 0,
    covered: 0,
    stopped: 0,
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

function summarize(paths: OrchPaths, run: RunState, fresh = false): RunSummary {
  annotateActivity(paths, run, Date.now(), fresh);
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

function runFileSignature(runDir: string): string {
  return [join(runDir, "state.json"), join(runDir, "events.jsonl")].map((file) => {
    try {
      return `${statSync(file).mtimeMs}`;
    } catch {
      // The run or file may disappear during a scan.
      return "missing";
    }
  }).join(":");
}

/** The run ids under `runsDir`, memoised (see `runDirNames`): for other scanners that poll the folder. */
export function listRunIds(runsDir: string): string[] {
  return runDirNames(runsDir);
}

/**
 * Run ids of `runsDir`. The directory is listed again only when its own mtime changed (a run was added
 * or removed) or the last listing is older than NAMES_MAX_AGE_MS; a `readdir` spikes to 100+ ms on macOS.
 */
const NAMES_MAX_AGE_MS = 30_000;
const namesMemo = new Map<string, { mtime: number; at: number; names: string[] }>();

function runDirNames(runsDir: string): string[] {
  const now = Date.now();
  let mtime: number;
  try {
    mtime = statSync(runsDir).mtimeMs;
  } catch {
    return [];
  }
  const memo = namesMemo.get(runsDir);
  if (memo !== undefined && memo.mtime === mtime && now - memo.at < NAMES_MAX_AGE_MS) {
    return memo.names;
  }
  let names: string[];
  try {
    names = readdirSync(runsDir).filter(isRunId).sort();
  } catch {
    names = [];
  }
  namesMemo.set(runsDir, { mtime, at: now, names });
  return names;
}

/** Run id -> state.json and events.jsonl mtimes, one stat pair per run. */
function scanRunSignatures(runsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of runDirNames(runsDir)) {
    out.set(name, runFileSignature(join(runsDir, name)));
  }
  return out;
}


/** True when the run has a state.json on disk. Cheap: one stat, no parse. */
export function runExists(paths: OrchPaths, id: string): boolean {
  if (!isRunId(id)) {
    return false;
  }
  try {
    statSync(join(paths.runs, id, STATE_FILE));
    return true;
  } catch {
    return false;
  }
}

/** True for a real directory (a symlink is not, as with `Dirent.isDirectory`). */
function isRunDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `runs/<id>/state.json` as a `RunSummary`, newest `started` first. Entries that are not a
 * valid run id, not a real directory (symlinks included — `isDirectory()` is false for them), or
 * have no state.json yet are skipped quietly; an unusable state.json is skipped with a stderr line.
 */
export interface RunListResult {
  runs: RunSummary[];
  cache: { mode: "cache" | "bypass"; source: "hit" | "miss" | "fresh"; age_ms: number };
}

const listCache = new Map<string, { at: number; signature: string; runs: RunSummary[] }>();
const LIST_CACHE_MS = 500;

/**
 * Last summary per run directory, keyed by its state.json and events.jsonl mtimes. A run that is not
 * running and whose files did not change is reused without a parse; running runs are always recomputed,
 * because their activity and stale flags depend on the clock and on the out dirs.
 */
const summaryMemo = new Map<string, { signature: string; running: boolean; summary: RunSummary; at: number }>();
/** A running run's summary is reused for this long even when its files changed: events.jsonl changes several times a second. */
const RUNNING_SUMMARY_MS = 1000;

export function listRuns(paths: OrchPaths, bypass = false): RunSummary[] {
  return listRunsCached(paths, bypass).runs;
}

export function listRunsCached(paths: OrchPaths, bypass = false): RunListResult {
  const now = Date.now();
  const cached = listCache.get(paths.runs);
  // A list holding a running run changes on every events.jsonl write, so its signature is not a
  // usable key: it is reused for the same short window the running summaries already use.
  const hasRunning = cached?.runs.some((r) => r.status === "running") ?? false;
  if (!bypass && cached !== undefined && hasRunning && now - cached.at < RUNNING_SUMMARY_MS) {
    return { runs: cached.runs, cache: { mode: "cache", source: "hit", age_ms: now - cached.at } };
  }
  const signatures = scanRunSignatures(paths.runs);
  const signature = [...signatures].map(([name, sig]) => `${name}:${sig}`).join("|");
  if (!bypass && cached !== undefined && now - cached.at < LIST_CACHE_MS && cached.signature === signature) {
    return { runs: cached.runs, cache: { mode: "cache", source: "hit", age_ms: now - cached.at } };
  }
  if (!bypass && cached !== undefined && !hasRunning && cached.signature === signature) {
    // Nothing on disk changed and no run is active, so the list is exact: refresh its window and reuse it.
    listCache.set(paths.runs, { ...cached, at: now });
    return { runs: cached.runs, cache: { mode: "cache", source: "hit", age_ms: 0 } };
  }

  const summaries: RunSummary[] = [];
  for (const name of runDirNames(paths.runs)) {
    if (!isRunId(name) || !isRunDirectory(join(paths.runs, name))) {
      continue;
    }
    const runDir = join(paths.runs, name);
    const sig = signatures.get(name) ?? "";
    const memo = summaryMemo.get(runDir);
    const reusable = memo !== undefined && memo.signature === sig && !memo.running;
    const recentRunning = memo !== undefined && memo.running && now - memo.at < RUNNING_SUMMARY_MS;
    if (!bypass && memo !== undefined && (reusable || recentRunning)) {
      summaries.push(memo.summary);
      continue;
    }
    const loaded = loadState(runDir);
    if (loaded === null) {
      summaryMemo.delete(runDir);
      continue;
    }
    if (!loaded.ok) {
      console.error(`runs: skipping ${name}: ${loaded.reason}`);
      summaryMemo.delete(runDir);
      continue;
    }
    const summary = summarize(paths, loaded.state, bypass);
    summaryMemo.set(runDir, { signature: sig, running: loaded.state.status === "running", summary, at: now });
    summaries.push(summary);
  }
  // Same as the old jq `sort_by(.started) | reverse`: a stable ascending sort, then reversed.
  const runs = summaries.sort((a, b) => compareStrings(a.started, b.started)).reverse();
  listCache.set(paths.runs, { at: now, signature, runs });
  return { runs, cache: { mode: bypass ? "bypass" : "cache", source: bypass ? "fresh" : (cached === undefined ? "miss" : "fresh"), age_ms: 0 } };
}

const readCache = new Map<string, { at: number; signature: string; result: RunReadResult }>();
const READ_CACHE_MS = 500;

export interface ReadRunResultCache {
  result: RunReadResult;
  cache: { mode: "cache" | "bypass"; source: "hit" | "miss" | "fresh"; age_ms: number };
}

export function readRunCached(paths: OrchPaths, id: string, bypass = false): ReadRunResultCache {
  const key = `${paths.runs}/${id}`;
  const runDir = join(paths.runs, id);
  const signature = [join(runDir, "state.json"), join(runDir, "events.jsonl")].map((file) => {
    try { return `${statSync(file).mtimeMs}`; } catch { return "missing"; }
  }).join(":");
  const now = Date.now();
  const cached = readCache.get(key);
  if (!bypass && cached !== undefined && now - cached.at < READ_CACHE_MS && cached.signature === signature) {
    return { result: cached.result, cache: { mode: "cache", source: "hit", age_ms: now - cached.at } };
  }
  const result = readRun(paths, id, bypass);
  readCache.set(key, { at: now, signature, result });
  return { result, cache: { mode: bypass ? "bypass" : "cache", source: bypass ? "fresh" : (cached === undefined ? "miss" : "fresh"), age_ms: 0 } };
}

export function readRun(paths: OrchPaths, id: string, fresh = false): RunReadResult {
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
  annotateActivity(paths, loaded.state, Date.now(), fresh);
  annotateTiming(loaded.state);
  return { kind: "ok", run: loaded.state };
}
