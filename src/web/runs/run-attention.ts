import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";

/** A running node older than this shows the long-running indicator. */
export const LONG_RUNNING_MS = 20 * 60 * 1000;

/** A node whose `started` is older than `thresholdMs` while still running. */
export function isLongRunning(node: RunNode, nowMs: number, thresholdMs: number = LONG_RUNNING_MS): boolean {
  if (node.status !== "running" || node.started === null) {
    return false;
  }
  const startedMs = Date.parse(node.started);
  return Number.isFinite(startedMs) && nowMs - startedMs > thresholdMs;
}

/** Whole minutes a running node has been running, for the indicator text. */
export function runningMinutes(node: RunNode, nowMs: number): number {
  const startedMs = node.started === null ? NaN : Date.parse(node.started);
  return Number.isFinite(startedMs) ? Math.floor((nowMs - startedMs) / 60000) : 0;
}

/** Running nodes of a paused run: they keep their state and are re-dispatched by resume. */
export function pausedNodes(run: RunState): RunNode[] {
  return run.paused === true ? run.nodes.filter((node) => node.status === "running") : [];
}

/** Snapshot of a run used to find what changed between two polls. */
export interface RunSnapshot {
  paused: boolean;
  stopped: boolean;
  nodes: ReadonlyMap<string, { status: string; error: string | null }>;
}

export function snapshotRun(run: RunState): RunSnapshot {
  return {
    paused: run.paused === true,
    stopped: run.stopped === true,
    nodes: new Map(run.nodes.map((node) => [node.id, { status: node.status, error: node.error ?? null }])),
  };
}

export type ChangeKind = "ok" | "error";

export interface Change {
  kind: ChangeKind;
  text: string;
}

/**
 * Feedback for what changed since `prev`. The first snapshot (prev null) reports nothing, so a page
 * load does not replay the run's history. A node that goes from stopped to running is "resumed".
 */
export function describeChanges(prev: RunSnapshot | null, next: RunSnapshot): Change[] {
  if (prev === null) {
    return [];
  }
  const changes: Change[] = [];
  if (!prev.paused && next.paused) {
    changes.push({ kind: "ok", text: "Run paused" });
  }
  if (prev.paused && !next.paused) {
    changes.push({ kind: "ok", text: "Run resumed" });
  }
  if (!prev.stopped && next.stopped) {
    changes.push({ kind: "ok", text: "Run stopped" });
  }
  for (const [id, node] of next.nodes) {
    const before = prev.nodes.get(id);
    if (before === undefined || before.status === node.status) {
      continue;
    }
    if (node.status === "running") {
      changes.push({ kind: "ok", text: before.status === "stopped" ? `${id} resumed` : `${id} running` });
    } else if (node.status === "done" || node.status === "covered") {
      changes.push({ kind: "ok", text: `${id} done` });
    } else if (node.status === "error") {
      changes.push({ kind: "error", text: node.error === null || node.error === "" ? `${id} failed` : `${id} failed: ${node.error}` });
    } else if (node.status === "stopped") {
      changes.push({ kind: "ok", text: `${id} stopped` });
    }
  }
  return changes;
}

/** Nodes in error, with their message, for the error banner. */
export function failedNodes(run: RunState): Array<{ id: string; error: string }> {
  return run.nodes.filter((node) => node.status === "error").map((node) => ({ id: node.id, error: node.error ?? "" }));
}
