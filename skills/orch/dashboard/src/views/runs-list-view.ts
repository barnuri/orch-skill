import type { NodeStatus } from "../../../shared/types/node-status";
import { RUN_STATUSES } from "../../../shared/types/run-status";
import type { RunSummary } from "../../../shared/types/run-summary";
import { STATUS_ORDER } from "../constants";
import { chip, el } from "../dom/el";
import { fmtTime } from "../dom/format";
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

function filterSelect(
  label: string,
  value: string,
  options: readonly { value: string; label: string }[],
  onChange: (next: string) => void,
): HTMLElement {
  const select = el("select", { class: "filter-select" }) as HTMLSelectElement;
  for (const option of options) {
    select.appendChild(el("option", { value: option.value, text: option.label }));
  }
  select.value = value;
  select.addEventListener("change", () => {
    onChange(select.value);
    render();
  });
  return el("label", { class: "filter-field" }, [
    el("span", { class: "filter-label", text: label }),
    select,
  ]);
}

function filterBar(state: AppState): HTMLElement {
  const filters = state.runFilters;
  const bar = el("div", { class: "run-filters", role: "search" });
  bar.append(
    filterSelect(
      "Age",
      filters.age,
      RUN_AGE_VALUES.map((age) => ({ value: age, label: AGE_LABELS[age] })),
      (next) => {
        state.runFilters = { ...filters, age: next as typeof filters.age };
        saveRunFilters(state.runFilters);
      },
    ),
    filterSelect(
      "Status",
      filters.status,
      [
        { value: ALL_STATUSES, label: "All statuses" },
        ...RUN_STATUSES.map((status) => ({ value: status, label: status })),
      ],
      (next) => {
        state.runFilters = { ...filters, status: next as typeof filters.status };
        saveRunFilters(state.runFilters);
      },
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
  return el("div", { class: "empty" }, [
    el("div", { text: `The current filters hide all ${hidden} ${noun}.` }),
    el("div", { class: "empty-action" }, [
      applyButton(state, "Show all runs", SHOW_ALL_RUN_FILTERS),
    ]),
  ]);
}

function subtitle(visible: readonly RunSummary[], hidden: number): string {
  const active = visible.filter((run) => run.status === "running").length;
  const counted = `${active} active, ${visible.length - active} finished`;
  return hidden === 0 ? counted : `${counted} — ${hidden} hidden by filters`;
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
  if (all.length === 0) {
    frag.appendChild(emptyState());
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
