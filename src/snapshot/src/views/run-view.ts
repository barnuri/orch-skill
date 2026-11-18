import type { NodeStatus } from "../../../shared/types/node-status";
import type { RunState } from "../../../shared/types/run-state";
import { ApiClient } from "../api/api-client";
import { STATUS_ORDER } from "../constants";
import { chip, el } from "../dom/el";
import { fmtTime } from "../dom/format";
import { markAgo, markLive } from "../dom/live-clock";
import { runTotals } from "../graph/node-metrics";
import type { Metric } from "../graph/node-metrics";
import { mountGraph } from "../graph/graph-viewport";
import { poll } from "../poll";
import type { AppState } from "../state/app-state";
import { confirmDialog } from "../ui/confirm-dialog";
import { toast } from "../ui/toast";
import { eventsFor } from "../state/run-events";
import { readRunView, renderRunTable, renderViewSwitch } from "./run-table-view";
import { renderNodePanel } from "./node-panel";
import { renderActivity, runUpdatedAt, staleBanner } from "./run-activity";

const api = new ApiClient();

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

function runStat(key: string, value: string, extraClass: string = "", title: string = ""): HTMLElement {
  const klass = extraClass === "" ? "run-stat" : `run-stat ${extraClass}`;
  const valueEl = el("b", { text: value });
  const stat = el("span", { class: klass }, [el("span", { class: "run-stat-key", text: key }), valueEl]);
  if (title !== "") {
    stat.setAttribute("title", title);
  }
  return stat;
}

function metricStat(key: string, metric: Metric, liveSince: string | null = null): HTMLElement {
  const stat = runStat(key, metric.text, metric.present ? "" : "missing", metric.title);
  const value = stat.querySelector("b");
  if (liveSince !== null && value !== null) {
    markLive(value, liveSince);
  }
  return stat;
}

function retryFailedNodes(run: RunState, button: HTMLButtonElement): void {
  button.disabled = true;
  void api.retryRun(run.run_id).then((result) => {
    button.disabled = false;
    if (result.kind === "ok") {
      toast("ok", "Retrying failed nodes");
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

async function stopRun(run: RunState, button: HTMLButtonElement): Promise<void> {
  const running = run.nodes.filter((node) => node.status === "running").length;
  const confirmed = await confirmDialog({
    title: `Stop run ${runTitle(run)}?`,
    body: `This stops ${running} running job(s), marks running nodes as cancelled errors, skips waiting nodes, and sets the run to cancelled.`,
    confirmLabel: "Stop run",
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  button.disabled = true;
  const result = await api.stopRun(run.run_id);
  button.disabled = false;
  if (result.kind === "ok") {
    toast("ok", "Run cancelled");
    void poll();
    return;
  }
  toast("error", result.kind === "error" ? (result.body?.error ?? "Stop failed") : "Stop failed");
}

function runActions(run: RunState): HTMLElement | null {
  const buttons: HTMLButtonElement[] = [];
  if (run.nodes.some((node) => node.status === "error")) {
    const retry = el("button", { class: "btn primary", type: "button", text: "Retry failed nodes" });
    retry.addEventListener("click", () => {
      retryFailedNodes(run, retry);
    });
    buttons.push(retry);
  }
  if (run.status === "running") {
    const stop = el("button", { class: "btn danger", type: "button", text: "Stop run" });
    stop.addEventListener("click", () => {
      void stopRun(run, stop);
    });
    buttons.push(stop);
  }
  if (buttons.length === 0) {
    return null;
  }
  return el("div", { class: "actions run-actions" }, buttons);
}

function renderMeta(run: RunState): HTMLElement {
  const counts = countNodes(run);
  const meta = el("div", { class: "meta run-meta", role: "list" });
  meta.appendChild(runStat("run", run.run_id, "mono"));
  meta.appendChild(runStat("started", fmtTime(run.started)));
  if (run.finished !== null) {
    meta.appendChild(runStat("finished", fmtTime(run.finished)));
  }
  const totals = runTotals(run);
  meta.appendChild(metricStat(run.finished === null ? "elapsed" : "duration", totals.duration, totals.duration.liveSince));
  meta.appendChild(metricStat("usage", totals.usage));
  const updatedAt = runUpdatedAt(run, eventsFor(run.run_id));
  if (updatedAt !== null) {
    const updated = runStat("updated", "", "run-stat-updated");
    const value = updated.querySelector("b");
    if (value !== null) {
      markAgo(value, updatedAt);
    }
    meta.appendChild(updated);
  }
  meta.appendChild(runStat("nodes", `${totals.done}/${totals.total} done`, "run-stat-done"));
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) ?? 0;
    if (count > 0 && status !== "done") {
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
        runActions(run),
      ]),
      renderMeta(run),
      staleBanner(run),
    ]),
  );
  const main = el("div", { class: "run-main" });
  const mountView = (view: "graph" | "table"): void => {
    main.replaceChildren(view === "table" ? renderRunTable(run, state.selectedNode, onSelect) : mountGraph(run, state.selectedNode, onSelect, state.profileHarness, state.maxAttempts));
  };
  const head = page.querySelector(".run-head");
  head?.appendChild(renderViewSwitch(readRunView(), mountView));
  mountView(readRunView());
  page.appendChild(el("div", { class: "layout run-layout" }, [main, renderNodePanel(run, state.selectedNode, state.maxAttempts)]));
  page.appendChild(renderActivity(eventsFor(run.run_id)));
  frag.appendChild(page);
  return frag;
}
