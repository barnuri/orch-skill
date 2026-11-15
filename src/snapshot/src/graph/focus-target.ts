import type { RunState } from "../../../shared/types/run-state";

export type FocusReason = "running" | "failed" | "next";

export interface FocusTarget {
  /** Every node that belongs to the focus (all the running ones, for example). */
  nodeIds: string[];
  /** The one to center on when they cannot all fit on screen. */
  primary: string;
  reason: FocusReason;
}

const time = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso) || 0);

/**
 * Which part of the graph matters right now. A running node comes first, since that is where the work
 * is. With nothing running, a failed node (it needs a person), then the next node ready to start.
 * Null when the run has settled and there is nothing to follow.
 */
export function focusTarget(run: RunState): FocusTarget | null {
  const running = run.nodes.filter((node) => node.status === "running");
  if (running.length > 0) {
    const latest = [...running].sort((a, b) => time(b.started) - time(a.started))[0];
    return { nodeIds: running.map((node) => node.id), primary: (latest ?? running[0]!).id, reason: "running" };
  }

  const failed = run.nodes.filter((node) => node.status === "error");
  if (failed.length > 0) {
    const latest = [...failed].sort((a, b) => time(b.finished) - time(a.finished))[0];
    return { nodeIds: failed.map((node) => node.id), primary: (latest ?? failed[0]!).id, reason: "failed" };
  }

  const settled = new Set(run.nodes.filter((node) => node.status === "done" || node.status === "skipped").map((node) => node.id));
  const needs = new Map<string, string[]>();
  for (const [from, to] of run.edges) {
    needs.set(to, [...(needs.get(to) ?? []), from]);
  }
  const ready = run.nodes.filter(
    (node) => node.status === "waiting" && (needs.get(node.id) ?? []).every((dep) => settled.has(dep)),
  );
  if (ready.length > 0) {
    return { nodeIds: ready.map((node) => node.id), primary: ready[0]!.id, reason: "next" };
  }
  return null;
}
