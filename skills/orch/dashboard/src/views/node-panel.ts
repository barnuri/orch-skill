import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { chip, el } from "../dom/el";
import { fmtDur, fmtTime } from "../dom/format";
import { renderNodeTranscript } from "./node-transcript";

const NODE_PANEL_ID: string = "node-panel";
const SELECTED_CLASS: string = "just-selected";

function detailRow(list: HTMLElement, key: string, value: string, cls: string = ""): void {
  list.appendChild(el("dt", { text: key }));
  list.appendChild(el("dd", { class: cls, text: value }));
}

function detailList(node: RunNode): HTMLElement {
  const list = el("dl");
  detailRow(list, "id", node.id, "mono");
  detailRow(list, "profile", node.profile ?? "—");
  detailRow(list, "adapter", node.adapter ?? "—");
  detailRow(list, "job", node.job_id ?? "—", "mono");
  detailRow(list, "session", node.session ?? "—", "mono");
  detailRow(list, "started", fmtTime(node.started));
  detailRow(list, "finished", fmtTime(node.finished));
  detailRow(list, "duration", fmtDur(node.started, node.finished));
  if (node.error !== null) {
    detailRow(list, "error", node.error, "err");
  }
  return list;
}

/** Node details panel below the graph: selected node's details + log tail, or a hint when none is. */
export function renderNodePanel(run: RunState, selectedId: string | null): HTMLElement {
  const node = run.nodes.find((candidate) => candidate.id === selectedId);
  const panel = el("aside", {
    class: "panel node-panel",
    id: NODE_PANEL_ID,
    "aria-live": "polite",
  });
  if (node === undefined) {
    const hint =
      run.nodes.length > 0
        ? "Select a node in the graph to see its profile, job and log."
        : "This run has no nodes yet.";
    panel.appendChild(el("h2", { text: "Node details" }));
    panel.appendChild(el("p", { class: "hint panel-empty", text: hint }));
    return panel;
  }
  panel.classList.add("has-node");
  panel.appendChild(el("h2", {}, [node.label || node.id, chip(node.status)]));
  const grid = el("div", { class: "panel-grid" });
  const details = el("div", { class: "panel-details" });
  details.appendChild(detailList(node));
  grid.append(details, renderNodeTranscript(node));
  panel.appendChild(grid);
  return panel;
}

/**
 * The graph fills the viewport, so a freshly rendered panel sits below the fold and a click
 * looks like it did nothing. Scroll it just into view and replay a one-shot border flash.
 */
export function revealNodePanel(): void {
  const panel = document.getElementById(NODE_PANEL_ID);
  if (panel === null) {
    return;
  }
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" });
  // The panel is rebuilt on every render, so the class is always fresh — but re-adding it
  // after a reflow keeps the flash replaying when the same panel is reused.
  panel.classList.remove(SELECTED_CLASS);
  void panel.offsetWidth;
  panel.classList.add(SELECTED_CLASS);
}
