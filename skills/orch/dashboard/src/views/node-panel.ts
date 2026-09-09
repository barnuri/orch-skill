import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { chip, el } from "../dom/el";
import { fmtDur, fmtTime } from "../dom/format";

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
  detailRow(list, "started", fmtTime(node.started));
  detailRow(list, "finished", fmtTime(node.finished));
  detailRow(list, "duration", fmtDur(node.started, node.finished));
  if (node.error !== null) {
    detailRow(list, "error", node.error, "err");
  }
  return list;
}

function logSection(node: RunNode): HTMLElement {
  const section = el("section", { class: "panel-log", "aria-label": "Log tail" });
  section.appendChild(el("h3", { class: "panel-log-title", text: "Log tail" }));
  if (node.log_tail.length > 0) {
    section.appendChild(el("pre", { text: node.log_tail.join("\n") }));
    return section;
  }
  const hint = node.job_id === null ? "Not dispatched yet." : "Log tail appears after the next run sync.";
  section.appendChild(el("p", { class: "hint", text: hint }));
  return section;
}

/** Node details panel below the graph: selected node's details + log tail, or a hint when none is. */
export function renderNodePanel(run: RunState, selectedId: string | null): HTMLElement {
  const node = run.nodes.find((candidate) => candidate.id === selectedId);
  const panel = el("aside", { class: "panel node-panel", "aria-live": "polite" });
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
  grid.append(details, logSection(node));
  panel.appendChild(grid);
  return panel;
}
