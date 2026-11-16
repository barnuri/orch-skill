/**
 * Node run time, from the timing fields `dispatch.ts` writes (core/state/timing.ts):
 * `dispatched_at` (trigger), `started_at` (first real activity), `finished_at`, the open segment
 * flag `seg_open`, and `run_segments` (one closed {dispatched, start, end} per earlier attempt).
 * Duration counts only time actually running, summed over attempts, minus the run's paused or
 * stopped stretches. Queue time (dispatched to started) is `waited`. Bun-free: web and server share it.
 */

export interface TimingSegment {
  dispatched: string | null;
  start: string | null;
  end: string | null;
}

export interface TimingPause {
  from: string;
  to: string | null;
}

/** The node fields this module reads. Every one is optional: older runs have none of them. */
export interface TimedNode {
  status: string;
  started?: string | null;
  finished?: string | null;
  dispatched_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  seg_open?: boolean | null;
  run_segments?: TimingSegment[] | null;
}

/** The run fields this module reads: closed pauses, and an open one while paused or stopped. */
export interface TimedRun {
  pauses?: TimingPause[] | null;
  paused?: boolean;
  paused_at?: string | null;
  stopped?: boolean;
  stopped_at?: string | null;
}

export type NodePhase = "waiting" | "starting" | "running" | "ended";

export interface NodeTiming {
  /** False for a node written before the timing fields existed: callers fall back to `started`. */
  known: boolean;
  phase: NodePhase;
  /** Milliseconds actually running, summed over attempts, pauses left out; null when it never started. */
  runMs: number | null;
  /** Milliseconds between dispatch and the first real activity, summed over attempts. */
  waitedMs: number;
  /** ISO start of the open running stretch, so a caller can tick; null when nothing runs now. */
  liveSince: string | null;
  /** ISO dispatch time of a node still starting, so a caller can tick its wait; else null. */
  waitingSince: string | null;
}

function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === "") {
    return null;
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** The run's paused or stopped stretches as [from, to] ms; an open one ends at `nowMs`. */
export function pauseSpans(run: TimedRun | null | undefined, nowMs: number): [number, number][] {
  if (run === null || run === undefined) {
    return [];
  }
  const spans: [number, number][] = [];
  for (const p of run.pauses ?? []) {
    const from = ms(p.from);
    const to = ms(p.to) ?? nowMs;
    if (from !== null && to > from) {
      spans.push([from, to]);
    }
  }
  const open = run.paused === true ? ms(run.paused_at) : run.stopped === true ? ms(run.stopped_at) : null;
  if (open !== null && nowMs > open) {
    spans.push([open, nowMs]);
  }
  return spans;
}

/** Length of [from, to] minus its overlap with the pause spans (assumed not to overlap each other). */
function activeMs(from: number, to: number, pauses: [number, number][]): number {
  if (to <= from) {
    return 0;
  }
  let total = to - from;
  for (const [a, b] of pauses) {
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (hi > lo) {
      total -= hi - lo;
    }
  }
  return Math.max(0, total);
}

export function hasTiming(node: TimedNode): boolean {
  return node.dispatched_at !== undefined || node.run_segments !== undefined || node.seg_open !== undefined;
}

/** True for a node dispatched but with no real activity yet. */
export function isStarting(node: TimedNode): boolean {
  return node.status === "running" && node.seg_open === true && (node.started_at ?? null) === null;
}

export function nodeTiming(node: TimedNode, run: TimedRun | null | undefined, nowMs: number): NodeTiming {
  const pauses = pauseSpans(run, nowMs);
  if (!hasTiming(node)) {
    const start = ms(node.started);
    const end = ms(node.finished);
    const live = node.status === "running" && start !== null;
    const runMs = start === null ? null : end !== null ? activeMs(start, end, pauses) : live ? activeMs(start, nowMs, pauses) : null;
    return {
      known: false,
      phase: node.status === "running" ? "running" : node.status === "waiting" ? "waiting" : "ended",
      runMs,
      waitedMs: 0,
      liveSince: live ? (node.started ?? null) : null,
      waitingSince: null,
    };
  }
  let runMs: number | null = null;
  let waitedMs = 0;
  const add = (n: number): void => {
    runMs = (runMs ?? 0) + n;
  };
  for (const seg of node.run_segments ?? []) {
    const d = ms(seg.dispatched);
    const s = ms(seg.start);
    const e = ms(seg.end);
    if (s !== null) {
      add(activeMs(s, e ?? s, pauses));
      if (d !== null) {
        waitedMs += activeMs(d, s, pauses);
      }
    } else if (d !== null && e !== null) {
      waitedMs += activeMs(d, e, pauses);
    }
  }
  const open = node.seg_open === true;
  const d = ms(node.dispatched_at);
  const s = ms(node.started_at);
  let phase: NodePhase = node.status === "waiting" ? "waiting" : node.status === "running" ? "running" : "ended";
  let liveSince: string | null = null;
  let waitingSince: string | null = null;
  if (open) {
    if (s !== null) {
      add(activeMs(s, nowMs, pauses));
      if (d !== null) {
        waitedMs += activeMs(d, s, pauses);
      }
      liveSince = node.status === "running" ? (node.started_at ?? null) : null;
    } else if (d !== null) {
      waitedMs += activeMs(d, nowMs, pauses);
      if (node.status === "running") {
        phase = "starting";
        waitingSince = node.dispatched_at ?? null;
      }
    }
  }
  return { known: true, phase, runMs, waitedMs, liveSince, waitingSince };
}

/** The per-node timing the dashboard API adds to each node (seconds, rounded down). */
export interface NodeTimingSummary {
  phase: NodePhase;
  /** Seconds actually running, summed over attempts, pauses left out; null when it never started. */
  run_s: number | null;
  /** Seconds between dispatch and first real activity, summed over attempts. */
  waited_s: number;
}

export function timingSummary(node: TimedNode, run: TimedRun | null | undefined, nowMs: number): NodeTimingSummary {
  const t = nodeTiming(node, run, nowMs);
  return { phase: t.phase, run_s: t.runMs === null ? null : Math.floor(t.runMs / 1000), waited_s: Math.floor(t.waitedMs / 1000) };
}
