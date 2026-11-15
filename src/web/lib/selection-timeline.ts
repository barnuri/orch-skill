import type { RunNode } from "../../shared/types/run-node";
import type { SelectionEvent } from "../../shared/types/selection-event";

/** Most recent hub events shown in the timeline; older ones stay in state.json. */
export const TIMELINE_VISIBLE_EVENTS = 50;

/** One timeline line for a hub selection event: stage, state, model and the reason it was chosen. */
export function formatSelectionLine(event: SelectionEvent): string {
  const parts = [`#${event.seq}`, event.stage, event.state, event.model ?? "no model"];
  if (event.reason_code !== null && event.reason_code !== "") {
    parts.push(event.reason_code);
  }
  const effort = event.sent_effort ?? event.selected_effort;
  if (effort !== null && effort !== "") {
    parts.push(`effort ${effort}`);
  }
  if (event.latency_ms !== null) {
    parts.push(`${event.latency_ms} ms`);
  }
  return parts.join(" · ");
}

/** The active-stage summary: `selecting`, `reviewing: judge, critic` or nothing when idle. */
export function activeStageSummary(node: RunNode): string | null {
  const stages = node.active_stages ?? [];
  if (stages.length === 0) {
    return null;
  }
  const reviewing = stages.filter((stage) => stage !== "solver");
  if (reviewing.length === 0) {
    return "selecting";
  }
  return `reviewing: ${reviewing.join(", ")}`;
}

/** The newest events first, capped at the visible limit, so a long run stays readable. */
export function timelineEvents(history: readonly SelectionEvent[]): SelectionEvent[] {
  return [...history].sort((a, b) => b.seq - a.seq).slice(0, TIMELINE_VISIBLE_EVENTS);
}

/** The hub pick line of a hub-mode node, or null when orch recorded no hub pick. */
export function hubPickSummary(node: RunNode): string | null {
  const hub = node.hub;
  if (hub === undefined || hub === null) {
    return null;
  }
  const expected = hub.expected?.model ?? "?";
  const tier = hub.expected?.tier ?? hub.actual?.tier ?? node.tier ?? null;
  const parts = [`hub expected ${expected}`];
  if (hub.actual !== null) {
    parts.push(`used ${hub.actual.model}`);
  }
  if (tier !== null) {
    parts.push(`tier ${tier}`);
  }
  if (hub.outcome !== null) {
    parts.push(hub.outcome);
  }
  return parts.join(" · ");
}
