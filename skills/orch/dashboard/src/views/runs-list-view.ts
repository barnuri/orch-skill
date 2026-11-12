import type { ActiveItem } from "../../../shared/types/active-item";
import type { NodeStatus } from "../../../shared/types/node-status";
import { RUN_STATUSES } from "../../../shared/types/run-status";
import type { RunSummary } from "../../../shared/types/run-summary";
import { STATUS_ORDER } from "../constants";
import { emptyState } from "../components/empty-state";
import { kpiTile } from "../components/kpi-tile";
import { labelled, segmented } from "../components/segmented";
import { skeletonRows } from "../components/skeleton";
import { chip, el } from "../dom/el";
import { rel, until } from "../dom/format";
import { render } from "../render";
import type { AppState } from "../state/app-state";
import type { RunFilters } from "../state/run-filters";
import {
  AGE_LABELS,
  ALL_STATUSES,
  DEFAULT_RUN_FILTERS,
  RUN_AGE_VALUES,
  SHOW_ALL_RUN_FILTERS,
  matchesRunFilters,
  runFiltersActive,
  saveRunFilters,
} from "../state/run-filters";
import { renderActiveStrip } from "./active-strip";
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
      ? `started ${rel(run.started)}`
      : `finished ${rel(run.finished)}`;
  return el("a", { class: `run-row is-${run.status}`, title: run.started, role: "listitem", href: `#/run/${encodeURIComponent(run.run_id)}` }, [
    el("div", {}, [
      el("div", { class: "title", text: run.title || run.run_id }),
      el("div", { class: "id mono", text: run.run_id }),
    ]),
    chip(run.status),
    statusBar(run.counts, total),
    countsText(run.counts, total),
    el("div", { class: "when muted", title: run.finished ?? run.started, text: when }),
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

function filterBar(state: AppState): HTMLElement {
  const filters = state.runFilters;
  const bar = el("div", { class: "filter-bar", role: "search" });
  const apply = (next: RunFilters): void => {
    state.runFilters = next;
    saveRunFilters(next);
    render();
  };
  bar.append(
    labelled(
      "Age",
      segmented(
        "Age",
        filters.age,
        RUN_AGE_VALUES.map((age) => ({ value: age, label: AGE_LABELS[age] })),
        (next) => apply({ ...filters, age: next as typeof filters.age }),
      ),
    ),
    labelled(
      "Status",
      segmented(
        "Status",
        filters.status,
        [{ value: ALL_STATUSES, label: "All" }, ...RUN_STATUSES.map((status) => ({ value: status, label: status }))],
        (next) => apply({ ...filters, status: next as typeof filters.status }),
      ),
    ),
  );
  if (runFiltersActive(filters)) {
    bar.appendChild(applyButton(state, "Clear filters", DEFAULT_RUN_FILTERS));
  }
  return bar;
}

function applyButton(state: AppState, label: string, next: RunFilters): HTMLButtonElement {
  const button = el("button", { class: "btn", type: "button", text: label });
  button.addEventListener("click", () => {
    state.runFilters = { ...next };
    saveRunFilters(state.runFilters);
    render();
  });
  return button;
}

/**
 * Filters hiding every run is a dead end without a way back out of it — and "clear" is not
 * that way out, because the default filters are what hide a list of only older runs.
 */
function filteredOutState(state: AppState, hidden: number): HTMLElement {
  const noun = hidden === 1 ? "run" : "runs";
  return emptyState(
    `No runs match the filters`,
    `The current filters hide all ${hidden} ${noun}. Widen the age or press Show all runs.`,
    applyButton(state, "Show all runs", SHOW_ALL_RUN_FILTERS),
  );
}

function subtitle(visible: readonly RunSummary[], hidden: number): string {
  const active = visible.filter((run) => run.status === "running").length;
  const counted = `${active} active, ${visible.length - active} finished`;
  return hidden === 0 ? counted : `${counted} — ${hidden} hidden by filters`;
}

function noRunsState(): HTMLElement {
  const hint = el("span", {}, ["Start one with ", el("code", { text: 'dispatch.sh run start "<title>"' }), ", then add nodes and dispatch them."]);
  return emptyState("No runs yet", hint);
}

// A loop is also a run (its id starts with "loop-"); the Loops tile counts it, so this one does not.
const isLoopRun = (run: RunSummary): boolean => run.run_id.startsWith("loop-");

function kpis(allRuns: readonly RunSummary[], active: readonly ActiveItem[]): HTMLElement {
  const runs = allRuns.filter((run) => !isLoopRun(run));
  const running = runs.filter((run) => run.status === "running").length;
  const failedRuns = runs.filter((run) => run.status === "error").length;
  const attention = failedRuns + active.filter((item) => item.status !== "running").length;
  const loops = active.filter((item) => item.kind === "loop" && item.status === "running");
  const watches = active.filter((item) => item.kind === "watch" && item.status === "running");
  const events = watches.reduce((sum, item) => sum + (item.events ?? 0), 0);
  const soonest = loops.map((item) => item.next ?? 0).filter((next) => next > 0).sort((a, b) => a - b)[0];
  const row = el("div", { class: "kpis" });
  row.append(
    kpiTile("Running runs", String(running), `of ${runs.length} in the last window`, running > 0 ? "acc" : "neutral"),
    kpiTile("Needs attention", String(attention), attention > 0 ? "failed runs, loops or monitors" : "all clear", attention > 0 ? "er" : "ok"),
    kpiTile("Loops", String(loops.length), soonest === undefined ? "none running" : `next tick in ${until(soonest)}`, loops.length > 0 ? "acc" : "neutral"),
    kpiTile("Monitors", String(watches.length), watches.length === 0 ? "none running" : `${events} ${events === 1 ? "event" : "events"} captured`, watches.length > 0 ? "pu" : "neutral"),
  );
  return row;
}

/** The `#/` page body. Crumb and `document.title` are set by `render()`, not here. */
export function renderRunsList(state: AppState): DocumentFragment {
  const all = sortedRuns(state.runs ?? []);
  const now = Date.now();
  const runs = all.filter((run) => matchesRunFilters(run, state.runFilters, now));
  const hidden = all.length - runs.length;
  const frag = document.createDocumentFragment();
  const sub = all.length > 0 ? subtitle(runs, hidden) : "Nothing has been dispatched yet.";
  frag.appendChild(pageHead("Runs", sub));
  if (state.lastError !== null && state.runs === null) {
    frag.appendChild(el("div", { class: "notice", text: `Could not load runs: ${state.lastError}` }));
  }
  if (state.runs === null && state.lastError === null) {
    frag.appendChild(skeletonRows(4));
    return frag;
  }
  frag.appendChild(kpis(all, state.active));
  const strip = renderActiveStrip(state.active);
  if (strip !== null) {
    frag.appendChild(strip);
  }
  frag.appendChild(
    el("div", { class: "section-head" }, [
      el("h2", { class: "section-title", text: "Recent runs" }),
      el("span", { class: "section-meta", text: `${runs.length} of ${all.length}` }),
    ]),
  );
  if (all.length === 0) {
    frag.appendChild(noRunsState());
    return frag;
  }
  frag.appendChild(filterBar(state));
  if (runs.length === 0) {
    frag.appendChild(filteredOutState(state, hidden));
    return frag;
  }
  const list = el("div", { class: "runs", role: "list" });
  for (const run of runs) {
    list.appendChild(renderRunRow(run));
  }
  frag.appendChild(list);
  return frag;
}
