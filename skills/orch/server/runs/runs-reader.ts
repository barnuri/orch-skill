import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { NODE_STATUSES } from "../../shared/types/node-status";
import type { NodeStatus } from "../../shared/types/node-status";
import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";
import type { OrchPaths } from "../types/orch-paths";
import { isRunId } from "./run-id";

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

function summarize(run: RunState): RunSummary {
  return {
    run_id: run.run_id,
    title: run.title,
    status: run.status,
    started: run.started,
    finished: run.finished,
    harness_session: run.harness_session,
    counts: countNodes(run),
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
    summaries.push(summarize(loaded.state));
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
  return { kind: "ok", run: loaded.state };
}
