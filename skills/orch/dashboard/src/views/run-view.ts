import type { NodeStatus } from "../../../shared/types/node-status";
import type { RunState } from "../../../shared/types/run-state";
import { STATUS_ORDER } from "../constants";
import { chip, el } from "../dom/el";
import { fmtDur, fmtTime } from "../dom/format";
import { mountGraph } from "../graph/graph-viewport";
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

function runStat(key: string, value: string, extraClass: string = ""): HTMLElement {
  const klass = extraClass === "" ? "run-stat" : `run-stat ${extraClass}`;
  return el("span", { class: klass }, [el("span", { class: "run-stat-key", text: key }), el("b", { text: value })]);
}

function renderMeta(run: RunState): HTMLElement {
  const counts = countNodes(run);
  const meta = el("div", { class: "meta run-meta", role: "list" });
  meta.appendChild(runStat("run", run.run_id, "mono"));
  meta.appendChild(runStat("started", fmtTime(run.started)));
  if (run.finished === null) {
    meta.appendChild(runStat("elapsed", fmtDur(run.started)));
  } else {
    meta.appendChild(runStat("finished", fmtTime(run.finished)));
  }
  meta.appendChild(runStat("nodes", String(run.nodes.length)));
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) ?? 0;
    if (count > 0) {
      meta.appendChild(runStat(status, String(count), `run-stat-${status}`));
    }
  }
  if (run.harness_session !== "") {
    meta.appendChild(runStat("session", run.harness_session, "mono"));
  }
  return meta;
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

/** The `#/run/<id>` page body: head, meta line, full-width graph, then node details below. */
export function renderRun(state: AppState, onSelect: (nodeId: string) => void): DocumentFragment {
  const runId = state.route.kind === "run" ? state.route.runId : "";
  const frag = document.createDocumentFragment();
  const run = state.run;
  if (run === null) {
    renderMissingRun(frag, runId, state.runMissing);
    return frag;
  }
  const page = el("div", { class: "run-page" });
  page.appendChild(
    el("div", { class: "run-page-header" }, [
      el("div", { class: "run-head" }, [
        el("h1", { text: runTitle(run) }),
        chip(run.status),
        el("a", { class: "muted", href: "#/", text: "← all runs" }),
      ]),
      renderMeta(run),
    ]),
  );
  page.appendChild(
    el("div", { class: "layout run-layout" }, [
      mountGraph(run, state.selectedNode, onSelect, state.profileHarness),
      renderNodePanel(run, state.selectedNode),
    ]),
  );
  frag.appendChild(page);
  return frag;
}
