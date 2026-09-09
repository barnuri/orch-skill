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

function logTail(node: RunNode): HTMLElement {
  if (node.log_tail.length > 0) {
    return el("pre", { text: node.log_tail.join("\n") });
  }
  const hint = node.job_id === null ? "Not dispatched yet." : "Log tail appears after the next run sync.";
  return el("p", { class: "hint", text: hint });
}

/** The right-hand `aside.panel`: the selected node's details + log tail, or a hint when none is. */
export function renderNodePanel(run: RunState, selectedId: string | null): HTMLElement {
  const node = run.nodes.find((candidate) => candidate.id === selectedId);
  const panel = el("aside", { class: "panel", "aria-live": "polite" });
  if (node === undefined) {
    const hint =
      run.nodes.length > 0
        ? "Select a node in the graph to see its profile, job and log."
        : "This run has no nodes yet.";
    panel.appendChild(el("h2", { text: "Node details" }));
    panel.appendChild(el("p", { class: "hint", text: hint }));
    return panel;
  }
  panel.appendChild(el("h2", {}, [node.label || node.id, chip(node.status)]));
  panel.appendChild(detailList(node));
  panel.appendChild(logTail(node));
  return panel;
}
