import type { NodeHealth } from "../../shared/types/run-health";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { isLongRunning, LONG_RUNNING_MS, runningMinutes } from "../runs/run-attention";
import { handoffText, nodeFlags, reviewReason } from "./node-flags";

export const MARKER_CODES = ["failed", "review", "stuck-after-result", "stalled", "long", "ready", "no-handoff", "unowned"] as const;
export type MarkerCode = (typeof MARKER_CODES)[number];

/** A short per-node state flag: icon and word come from the code, colour from the tone's status tokens. */
export interface NodeMarker {
  code: MarkerCode;
  word: string;
  tone: "error" | "warn" | "ok" | "info";
  title: string;
}

export const MARKER_ICON: Readonly<Record<MarkerCode, string>> = { failed: "✕", review: "?", "stuck-after-result": "⏸", stalled: "◔", long: "⏱", ready: "▷", "no-handoff": "▫", unowned: "○" };

export interface MarkerContext {
  nowMs: number;
  /** Ids the projection says are ready to start. */
  ready: ReadonlySet<string>;
  /** The watcher's verdict for the node, when known. */
  health?: NodeHealth | undefined;
  thresholdMs?: number;
}

/** The markers that apply to one node. Pure; empty for a healthy node. */
export function nodeMarkers(node: RunNode, ctx: MarkerContext): NodeMarker[] {
  const out: NodeMarker[] = [];
  const flags = nodeFlags(node);
  // Run-level boxes ("N nodes failed", "N nodes need review") became these markers: the node carries its own flag.
  if (node.status === "error") {
    const why = typeof node.error === "string" && node.error !== "" ? node.error : "the job failed";
    out.push({ code: "failed", word: "failed", tone: "error", title: why });
  }
  const review = reviewReason(node);
  if (review !== null) {
    out.push({ code: "review", word: "review", tone: "warn", title: `${review}: record a result (dispatch.ts node result) after you check it` });
  }
  const idle = ctx.health?.idle_min ?? null;
  const stuck = node.status === "running" ? node.stuck_after_result : null;
  if (stuck) {
    const since = stuck.since ? Date.parse(stuck.since) : Number.NaN;
    const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((ctx.nowMs - since) / 60_000)) : (stuck.idle_min ?? null);
    out.push({ code: "stuck-after-result", word: "stuck after result", tone: "warn", title: `Result recorded, but job ${stuck.job ?? "?"} still runs${minutes === null ? "" : ` with an idle log for ${minutes} min`}. Reap it: dispatch.ts node reap` });
  }
  if (flags.stale || ctx.health?.health === "stalled") {
    out.push({ code: "stalled", word: "stalled", tone: "warn", title: idle === null ? "No activity for a while" : `No activity for ${idle} min` });
  }
  if (isLongRunning(node, ctx.nowMs, ctx.thresholdMs ?? LONG_RUNNING_MS)) {
    const minutes = runningMinutes(node, ctx.nowMs);
    out.push({ code: "long", word: `${minutes}m`, tone: "warn", title: `Running for ${minutes} min` });
  }
  if (node.status === "waiting" && ctx.ready.has(node.id)) {
    out.push({ code: "ready", word: "ready", tone: "ok", title: "All dependencies are done: ready to start" });
  }
  if (node.status === "done" && handoffText(node)?.missing === true) {
    out.push({ code: "no-handoff", word: "no handoff", tone: "warn", title: "handoff.md is missing or empty" });
  }
  if (flags.unowned || ctx.health?.health === "unowned") {
    out.push({ code: "unowned", word: "unowned", tone: "warn", title: "Marked running, but no owner or job is recorded" });
  }
  return out;
}

export function markerMap(run: RunState, ctx: Omit<MarkerContext, "health">, health: readonly NodeHealth[]): ReadonlyMap<string, NodeMarker[]> {
  const byId = new Map(health.map((entry) => [entry.id, entry]));
  const out = new Map<string, NodeMarker[]>();
  for (const node of run.nodes) {
    const list = nodeMarkers(node, { ...ctx, health: byId.get(node.id) });
    if (list.length > 0) {
      out.set(node.id, list);
    }
  }
  return out;
}

export interface MarkerCount {
  code: MarkerCode;
  count: number;
}

/** Counts per code, in the fixed display order; codes with no node are left out. */
export function markerCounts(map: ReadonlyMap<string, readonly NodeMarker[]>): MarkerCount[] {
  return MARKER_CODES.map((code) => ({ code, count: [...map.values()].filter((list) => list.some((m) => m.code === code)).length })).filter((entry) => entry.count > 0);
}

export function idsWithMarker(map: ReadonlyMap<string, readonly NodeMarker[]>, code: MarkerCode): ReadonlySet<string> {
  return new Set([...map].filter(([, list]) => list.some((m) => m.code === code)).map(([id]) => id));
}
