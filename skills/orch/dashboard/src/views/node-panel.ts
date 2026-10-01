import type { NodeCost } from "../../../shared/types/node-cost";
import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { ApiClient } from "../api/api-client";
import { chip, el } from "../dom/el";
import { fmtDur, fmtTime, fmtUsd } from "../dom/format";
import { poll } from "../poll";
import { toast } from "../ui/toast";
import { renderNodeTranscript } from "./node-transcript";

const NODE_PANEL_ID: string = "node-panel";
const SELECTED_CLASS: string = "just-selected";
const api = new ApiClient();

function detailRow(list: HTMLElement, key: string, value: string, cls: string = ""): void {
  list.appendChild(el("dt", { text: key }));
  list.appendChild(el("dd", { class: cls, text: value }));
}

function fmtCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/**
 * The cost rows. `cost_basis` is the harness's own word for what the figure means — in practice
 * `list`, i.e. list price, which is not what a subscription is billed. Saying so is the whole
 * point of carrying the field: a bare dollar amount would read as money actually charged.
 */
function appendCostRows(list: HTMLElement, cost: NodeCost): void {
  detailRow(list, "cost", `${fmtUsd(cost.usd)} ${cost.cost_basis} price`);
  detailRow(
    list,
    "tokens",
    `${fmtCount(cost.input_tokens)} in · ${fmtCount(cost.output_tokens)} out`,
    "mono",
  );
  if (cost.cache_read_tokens > 0 || cost.cache_creation_tokens > 0) {
    detailRow(
      list,
      "cache",
      `${fmtCount(cost.cache_read_tokens)} read · ${fmtCount(cost.cache_creation_tokens)} written`,
      "mono",
    );
  }
  // Only worth a breakdown when more than one model was touched; otherwise it restates the rows
  // above with the model id the profile already names. One row, not one per model: the panel's
  // key column is a fixed 84px and a model id does not fit in it.
  if (cost.models.length < 2) {
    return;
  }
  const lines = cost.models
    .map((model) => `${model.model}  ${fmtUsd(model.usd)}`)
    .join("\n");
  detailRow(list, "models", lines, "mono cost-models");
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
  const cost = node.cost;
  if (cost !== undefined && cost !== null) {
    appendCostRows(list, cost);
  }
  if (node.error !== null) {
    detailRow(list, "error", node.error, "err");
  }
  return list;
}

function retryNode(runId: string, node: RunNode, button: HTMLButtonElement): void {
  button.disabled = true;
  void api.retryNode(runId, node.id).then((result) => {
    button.disabled = false;
    if (result.kind === "ok") {
      toast("ok", `Retrying ${node.id}`);
      void poll();
      return;
    }
    if (result.kind === "error") {
      toast("error", result.body?.error ?? "Retry failed");
      return;
    }
    toast("error", "Retry failed");
  });
}

function retryButton(run: RunState, node: RunNode): HTMLButtonElement | null {
  if (node.status !== "error") {
    return null;
  }
  const button = el("button", { class: "btn primary", type: "button", text: "Retry" });
  button.addEventListener("click", () => {
    retryNode(run.run_id, node, button);
  });
  return button;
}

function attemptsHistory(node: RunNode): HTMLElement | null {
  const attempts = node.attempts ?? [];
  if (attempts.length === 0) {
    return null;
  }
  const items = attempts.map((attempt, index) => {
    const tail = attempt.log_tail ?? [];
    const lines = [
      `#${index + 1}`,
      attempt.profile ?? attempt.adapter ?? "—",
      attempt.finished === null ? "not finished" : fmtTime(attempt.finished),
      attempt.error ?? "no error",
      attempt.reason ?? "",
    ].filter((part) => part !== "");
    return el("li", { class: "attempt-item" }, [
      el("div", { class: "mono", text: lines.join(" · ") }),
      tail.length > 0
        ? el("pre", { class: "transcript attempt-tail", text: tail.join("\n") })
        : null,
    ]);
  });
  return el("section", { class: "attempts", "aria-label": "Attempts history" }, [
    el("h3", { class: "panel-log-title", text: `Attempts — ${attempts.length}` }),
    el("ol", {}, items),
  ]);
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
  panel.appendChild(el("h2", {}, [node.label || node.id, chip(node.status), retryButton(run, node)]));
  const grid = el("div", { class: "panel-grid" });
  const details = el("div", { class: "panel-details" });
  details.appendChild(detailList(node));
  const attempts = attemptsHistory(node);
  if (attempts !== null) {
    details.appendChild(attempts);
  }
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
