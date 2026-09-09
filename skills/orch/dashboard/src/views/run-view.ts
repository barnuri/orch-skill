import type { NodeStatus } from "../../../shared/types/node-status";
import type { RunState } from "../../../shared/types/run-state";
import { STATUS_ORDER } from "../constants";
import { chip, el } from "../dom/el";
import { fmtDur, fmtTime } from "../dom/format";
import { renderGraph } from "../graph/render-graph";
import type { AppState } from "../state/app-state";
import { renderNodePanel } from "./node-panel";

function runTitle(run: RunState): string {
  return run.title || run.run_id;
}

function countNodes(run: RunState): Map<NodeStatus, number> {
  const counts = new Map<NodeStatus, number>();
  for (const node of run.nodes) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  return counts;
}

function metaItem(key: string, value: string): HTMLElement {
  return el("span", {}, [`${key} `, el("b", { text: value })]);
}

function renderMeta(run: RunState): HTMLElement {
  const counts = countNodes(run);
  const meta = el("div", { class: "meta" });
  meta.appendChild(metaItem("run", run.run_id));
  meta.appendChild(metaItem("started", fmtTime(run.started)));
  if (run.finished === null) {
    meta.appendChild(metaItem("elapsed", fmtDur(run.started)));
  } else {
    meta.appendChild(metaItem("finished", fmtTime(run.finished)));
  }
  meta.appendChild(metaItem("nodes", String(run.nodes.length)));
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) ?? 0;
    if (count > 0) {
      meta.appendChild(metaItem(status, String(count)));
    }
  }
  if (run.harness_session !== "") {
    meta.appendChild(metaItem("session", run.harness_session));
  }
  return meta;
}

function renderGraphBox(run: RunState, selectedId: string | null, onSelect: (nodeId: string) => void): HTMLElement {
  const graph = el("div", { class: "graph" });
  if (run.nodes.length === 0) {
    graph.appendChild(el("div", { class: "empty", text: "No nodes yet. Add some with dispatch.sh node add." }));
    return graph;
  }
  graph.appendChild(renderGraph(run, selectedId, onSelect));
  return graph;
}

/** Shown while the run has not loaded: a 404 becomes the "pruned" notice, anything else "Loading…". */
function renderMissingRun(frag: DocumentFragment, runId: string, missing: boolean): void {
  frag.appendChild(el("h1", { text: runId }));
  if (!missing) {
    frag.appendChild(el("div", { class: "sub", text: "Loading…" }));
    return;
  }
  frag.appendChild(el("div", { class: "notice", text: "Run not found — it may have been pruned." }));
  frag.appendChild(el("a", { href: "#/", text: "← Back to runs" }));
}

/** The `#/run/<id>` page body: head, meta line, then graph + node panel side by side. */
export function renderRun(state: AppState, onSelect: (nodeId: string) => void): DocumentFragment {
  const runId = state.route.kind === "run" ? state.route.runId : "";
  const frag = document.createDocumentFragment();
  const run = state.run;
  if (run === null) {
    renderMissingRun(frag, runId, state.runMissing);
    return frag;
  }
  frag.appendChild(
    el("div", { class: "run-head" }, [
      el("h1", { text: runTitle(run) }),
      chip(run.status),
      el("a", { class: "muted", href: "#/", text: "← all runs" }),
    ]),
  );
  frag.appendChild(renderMeta(run));
  frag.appendChild(
    el("div", { class: "layout" }, [
      renderGraphBox(run, state.selectedNode, onSelect),
      renderNodePanel(run, state.selectedNode),
    ]),
  );
  return frag;
}
