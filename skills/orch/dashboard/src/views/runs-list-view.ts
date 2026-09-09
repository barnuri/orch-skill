import type { NodeStatus } from "../../../shared/types/node-status";
import type { RunSummary } from "../../../shared/types/run-summary";
import { STATUS_ORDER } from "../constants";
import { chip, el } from "../dom/el";
import { fmtTime } from "../dom/format";
import type { AppState } from "../state/app-state";
import { pageHead } from "./page-head";

type Counts = Record<NodeStatus, number>;

function totalOf(counts: Counts): number {
  return STATUS_ORDER.reduce((sum, status) => sum + counts[status], 0);
}

// Widths go through the CSSOM, not a `style` attribute: the shell's CSP has no 'unsafe-inline'.
function statusBar(counts: Counts, total: number): HTMLElement {
  const bar = el("div", { class: "bar", title: `${total} nodes` });
  for (const status of STATUS_ORDER) {
    if (counts[status] === 0) {
      continue;
    }
    const segment = el("span", { class: status });
    segment.style.width = `${(100 * counts[status]) / total}%`;
    bar.appendChild(segment);
  }
  return bar;
}

function countsText(counts: Counts, total: number): HTMLElement {
  const text = el("div", { class: "counts" }, [el("b", { text: `${counts.done}/${total}` }), " done"]);
  if (counts.running > 0) {
    text.appendChild(document.createTextNode(`, ${counts.running} running`));
  }
  if (counts.error > 0) {
    text.appendChild(document.createTextNode(`, ${counts.error} failed`));
  }
  return text;
}

function renderRunRow(run: RunSummary): HTMLElement {
  const total = totalOf(run.counts);
  const when =
    run.status === "running"
      ? `started ${fmtTime(run.started)}`
      : `finished ${fmtTime(run.finished)}`;
  return el("a", { class: "run-row", role: "listitem", href: `#/run/${encodeURIComponent(run.run_id)}` }, [
    el("div", {}, [
      el("div", { class: "title", text: run.title || run.run_id }),
      el("div", { class: "id mono", text: run.run_id }),
    ]),
    chip(run.status),
    statusBar(run.counts, total),
    countsText(run.counts, total),
    el("div", { class: "when muted", text: when }),
  ]);
}

/** Active runs first, then newest `started` first — the server order is already `started` desc. */
function sortedRuns(runs: readonly RunSummary[]): RunSummary[] {
  return runs.slice().sort((a, b) => {
    const rankA = a.status === "running" ? 0 : 1;
    const rankB = b.status === "running" ? 0 : 1;
    return rankA - rankB || b.started.localeCompare(a.started);
  });
}

function emptyState(): HTMLElement {
  return el("div", { class: "empty" }, [
    "No runs yet. Start one with ",
    el("code", { text: 'dispatch.sh run start "<title>"' }),
    ", then add nodes and dispatch them.",
  ]);
}

/** The `#/` page body. Crumb and `document.title` are set by `render()`, not here. */
export function renderRunsList(state: AppState): DocumentFragment {
  const runs = sortedRuns(state.runs ?? []);
  const active = runs.filter((run) => run.status === "running").length;
  const frag = document.createDocumentFragment();
  const sub =
    runs.length > 0
      ? `${active} active, ${runs.length - active} finished`
      : "Nothing has been dispatched yet.";
  frag.appendChild(pageHead("Runs", sub));
  if (state.lastError !== null && state.runs === null) {
    frag.appendChild(el("div", { class: "notice", text: `Could not load runs: ${state.lastError}` }));
  }
  if (runs.length === 0) {
    frag.appendChild(emptyState());
    return frag;
  }
  const list = el("div", { class: "runs", role: "list" });
  for (const run of runs) {
    list.appendChild(renderRunRow(run));
  }
  frag.appendChild(list);
  return frag;
}
