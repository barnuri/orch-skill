import type { RunEvent } from "../../shared/types/run-event";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { nodeFlags } from "./node-flags";

const MS_PER_MINUTE = 60_000;
export const SHOWN_EVENTS = 50;
export const KEPT_EVENTS = 200;

export function describeEvent(e: RunEvent): string {
  switch (e.kind) {
    case "status":
      return `${e.from ?? "—"} → ${e.to ?? "—"}${e.note !== null ? `: ${e.note}` : ""}`;
    case "note":
      return e.note ?? "note";
    case "ping":
      return e.note !== null ? `progress ${e.note}` : "ping";
    case "add":
      return "added";
    case "remove":
      return "removed";
    case "retry":
      return "reset for retry";
    case "run":
      return `run ${e.to ?? ""}`.trim();
    default:
      return e.kind;
  }
}

function minutesQuiet(node: RunNode, nowMs: number): number {
  const at = node.last_activity ?? node.updated ?? node.started;
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((nowMs - t) / MS_PER_MINUTE));
}

export interface StaleSummary {
  headline: string;
  detail: string;
}

/** The text of the warning above the graph; null when no running node has gone quiet. */
export function staleSummary(run: RunState, nowMs: number): StaleSummary | null {
  const stale = run.nodes.filter((n) => nodeFlags(n).stale);
  if (stale.length === 0) {
    return null;
  }
  const mins = Math.min(...stale.map((n) => minutesQuiet(n, nowMs)));
  const noun = stale.length === 1 ? "node is" : "nodes are";
  const names = stale.map((n) => n.label || n.id).join(", ");
  return {
    headline: `${stale.length} ${noun} running but nothing has changed for ${mins} min. `,
    detail: `The coordinator may have stopped updating. ${names}`,
  };
}

/** Newest sign of life in the run, for "updated Ns ago". `events` are oldest first. */
export function runUpdatedAt(run: RunState, events: readonly RunEvent[]): string | null {
  const stamps: string[] = [run.started];
  for (const n of run.nodes) {
    for (const s of [n.updated, n.last_activity, n.finished, n.started]) {
      if (s) {
        stamps.push(s);
      }
    }
  }
  const last = events.at(-1);
  if (last) {
    stamps.push(last.at);
  }
  return stamps.reduce((best, s) => (Date.parse(s) > Date.parse(best) ? s : best));
}

/** Appends events newer than the ones held (by `n`), keeping the newest KEPT_EVENTS, oldest first. */
export function mergeEvents(held: readonly RunEvent[], fresh: readonly RunEvent[]): RunEvent[] {
  const top = held.at(-1)?.n ?? 0;
  const added = fresh.filter((e) => e.n > top);
  return added.length === 0 ? (held as RunEvent[]) : [...held, ...added].slice(-KEPT_EVENTS);
}

/** Newest first, at most SHOWN_EVENTS. */
export function feedRows(events: readonly RunEvent[], node: string | null = null): RunEvent[] {
  const rows = node === null ? events : events.filter((e) => e.node === node);
  return [...rows].reverse().slice(0, SHOWN_EVENTS);
}
