import type { RunNode } from "../../../shared/types/run-node";
import type { SelectionEvent } from "../../../shared/types/selection-event";
import { el } from "../dom/el";
import { fmtTime } from "../dom/format";

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

/** The node panel's timeline, or null when the node has no hub selections yet. */
export function selectionTimeline(node: RunNode): HTMLElement | null {
  const history = node.selection_history ?? [];
  if (history.length === 0) {
    return null;
  }
  const header = [node.requested_selector ?? "", activeStageSummary(node) ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
  const items = timelineEvents(history).map((event) =>
    el("li", { class: "selection-item" }, [
      el("div", { class: "mono", text: formatSelectionLine(event) }),
      el("div", { class: "hint", text: fmtTime(event.ts) }),
    ]),
  );
  return el("section", { class: "selections", "aria-label": "Model selections" }, [
    el("h3", { class: "panel-log-title", text: `Selections — ${history.length}` }),
    header === "" ? null : el("p", { class: "hint", text: header }),
    el("ol", {}, items),
  ]);
}
