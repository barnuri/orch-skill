import type { Suggestion } from "../../../shared/types/suggestion";
import type { SuggestionApplyEnvelope } from "../../../shared/types/suggestion-apply-envelope";
import type { SuggestionsDocument } from "../../../shared/types/suggestions-document";
import { CONFIDENCE_VALUES, SUGGESTION_STATUSES } from "../../../shared/types/routing-enums";
import { ApiClient } from "../api/api-client";
import { chip, el } from "../dom/el";
import { invalidateDocument, poll } from "../poll";
import { render } from "../render";
import type { AppState } from "../state/app-state";
import { toast } from "../ui/toast";
import { pageHead } from "./page-head";

const api = new ApiClient();

const AUTO_APPLY_KINDS: ReadonlySet<string> = new Set([
  "memory_record",
  "profile_description",
  "model_description",
]);
const ALL_VALUE = "";

type SuggestionFilters = {
  status: string;
  kind: string;
  confidence: string;
};

const filters: SuggestionFilters = {
  status: "pending",
  kind: ALL_VALUE,
  confidence: ALL_VALUE,
};

function kindLabel(kind: string): string {
  return kind.replaceAll("_", " ");
}

function filtersActive(): boolean {
  return filters.status !== "pending" || filters.kind !== ALL_VALUE || filters.confidence !== ALL_VALUE;
}

function matchesFilters(item: Suggestion): boolean {
  if (filters.status !== ALL_VALUE && item.status !== filters.status) {
    return false;
  }
  if (filters.kind !== ALL_VALUE && item.kind !== filters.kind) {
    return false;
  }
  if (filters.confidence !== ALL_VALUE && item.confidence !== filters.confidence) {
    return false;
  }
  return true;
}

function kindOptions(items: readonly Suggestion[], catalog: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const kind of catalog) {
    seen.add(kind);
  }
  for (const item of items) {
    seen.add(item.kind);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function suggestionsDoc(state: AppState): SuggestionsDocument | null {
  const doc = state.doc?.kind === "suggestions" ? state.doc.document : null;
  if (doc === null || !("suggestions" in doc)) {
    return null;
  }
  return doc as SuggestionsDocument;
}

function pendingCount(items: readonly Suggestion[]): number {
  return items.filter((s) => s.status === "pending").length;
}

function isApplicable(item: Suggestion): boolean {
  return item.status === "pending" && AUTO_APPLY_KINDS.has(item.kind);
}

const selected = new Set<string>();
let applying = false;

function clearSelection(): void {
  selected.clear();
}

function refreshSuggestions(): void {
  invalidateDocument("suggestions");
  void poll();
}

function applyToast(result: SuggestionApplyEnvelope): void {
  if (result.failed === 0) {
    toast("ok", result.applied === 1 ? "Applied" : `Applied ${result.applied}`);
    return;
  }
  if (result.applied === 0) {
    toast("error", result.failed === 1 ? "Apply failed" : `${result.failed} failed`);
    return;
  }
  toast("error", `Applied ${result.applied}, ${result.failed} failed`);
}

function runApply(ids: string[] | undefined, all: boolean): void {
  if (applying) {
    return;
  }
  applying = true;
  render();
  void api.applySuggestions(ids, all).then((result) => {
    applying = false;
    clearSelection();
    if (result.kind === "ok") {
      applyToast(result.body);
      refreshSuggestions();
      if (result.body.applied > 0) {
        invalidateDocument("profiles");
        void poll();
      }
      return;
    }
    if (result.kind === "error") {
      toast("error", result.body?.error ?? "Apply failed");
    } else {
      toast("error", "Apply failed");
    }
    render();
  });
}

function previewText(item: Suggestion): string | null {
  if (item.kind === "profile_description" || item.kind === "model_description") {
    const desc = (item.action as { description?: string }).description;
    return typeof desc === "string" && desc !== "" ? desc : null;
  }
  if (item.kind === "memory_record" && item.action.memory !== undefined) {
    const mem = item.action.memory;
    const parts = [mem.profile, mem.outcome, mem.task_kind, mem.note].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return null;
}

function renderCard(item: Suggestion): HTMLElement {
  const actions = el("div", { class: "actions" });
  const headBits: HTMLElement[] = [];
  if (isApplicable(item)) {
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = selected.has(item.id);
    box.addEventListener("change", () => {
      if (box.checked) {
        selected.add(item.id);
      } else {
        selected.delete(item.id);
      }
      render();
    });
    headBits.push(box);
  }
  if (item.status === "pending") {
    if (isApplicable(item)) {
      const apply = el("button", { class: "btn primary", type: "button", text: "Apply" });
      apply.disabled = applying;
      apply.addEventListener("click", () => {
        runApply([item.id], false);
      });
      actions.append(apply);
    } else {
      actions.append(el("span", { class: "muted", text: "Not auto-applicable yet" }));
    }
    const dismiss = el("button", { class: "btn", type: "button", text: "Dismiss" });
    dismiss.disabled = applying;
    dismiss.addEventListener("click", () => {
      void api.dismissSuggestion(item.id).then((result) => {
        if (result.kind === "ok") {
          selected.delete(item.id);
          toast("ok", "Dismissed");
          refreshSuggestions();
        } else if (result.kind === "error") {
          toast("error", result.body?.error ?? "Dismiss failed");
        } else {
          toast("error", "Dismiss failed");
        }
      });
    });
    actions.append(dismiss);
  }
  const evidence = el("div", { class: "suggestion-evidence" });
  for (const ref of item.evidence) {
    if (ref.type === "run" && ref.id !== undefined) {
      const link = el("a", { class: "text-link", href: `#/run/${encodeURIComponent(ref.id)}`, text: ref.id });
      evidence.appendChild(link);
    }
  }
  const preview = previewText(item);
  const statusChip = item.status === "pending" ? null : chip(item.status);
  const bits: HTMLElement[] = [
    el("div", { class: "suggestion-head" }, [
      el("div", { class: "suggestion-chips" }, [...headBits, chip(item.confidence), chip(item.kind), statusChip]),
      el("h2", { class: "suggestion-title", text: item.title }),
    ]),
    el("p", { class: "suggestion-reason", text: item.reason }),
  ];
  if (preview !== null) {
    bits.push(el("p", { class: "suggestion-preview muted", text: preview }));
  }
  bits.push(evidence, actions);
  return el("article", { class: "suggestion-card", role: "listitem" }, bits);
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

function filterBar(items: readonly Suggestion[], catalogKinds: readonly string[]): HTMLElement {
  const bar = el("div", { class: "suggestion-filters", role: "search" });
  const statusOptions = [
    { value: ALL_VALUE, label: "All statuses" },
    ...SUGGESTION_STATUSES.map((status) => ({ value: status, label: status })),
  ];
  const kindOptionsList = [
    { value: ALL_VALUE, label: "All kinds" },
    ...kindOptions(items, catalogKinds).map((kind) => ({ value: kind, label: kindLabel(kind) })),
  ];
  const confidenceOptions = [
    { value: ALL_VALUE, label: "All confidence" },
    ...CONFIDENCE_VALUES.map((tier) => ({ value: tier, label: tier })),
  ];
  bar.append(
    filterSelect("Status", filters.status, statusOptions, (next) => {
      filters.status = next;
    }),
    filterSelect("Kind", filters.kind, kindOptionsList, (next) => {
      filters.kind = next;
    }),
    filterSelect("Confidence", filters.confidence, confidenceOptions, (next) => {
      filters.confidence = next;
    }),
  );
  if (filtersActive()) {
    const clear = el("button", { class: "btn", type: "button", text: "Clear filters" });
    clear.addEventListener("click", () => {
      filters.status = "pending";
      filters.kind = ALL_VALUE;
      filters.confidence = ALL_VALUE;
      render();
    });
    bar.appendChild(clear);
  }
  return bar;
}

function toolbar(pendingApplicable: readonly Suggestion[]): HTMLElement {
  const bar = el("div", { class: "toolbar suggestion-toolbar" });
  const scan = el("button", { class: "btn", type: "button", text: "Scan now" });
  scan.disabled = applying;
  scan.addEventListener("click", () => {
    void api.scanSuggestions().then((result) => {
      if (result.kind === "ok") {
        toast("ok", "Scan complete");
        refreshSuggestions();
      } else if (result.kind === "error") {
        toast("error", result.body?.error ?? "Scan failed");
      } else {
        toast("error", "Scan failed");
      }
    });
  });
  bar.appendChild(scan);
  if (pendingApplicable.length > 0) {
    const selectAll = el("input", { type: "checkbox", title: "Select all" }) as HTMLInputElement;
    const allIds = pendingApplicable.map((s) => s.id);
    selectAll.checked = allIds.length > 0 && allIds.every((id) => selected.has(id));
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) {
        for (const id of allIds) {
          selected.add(id);
        }
      } else {
        for (const id of allIds) {
          selected.delete(id);
        }
      }
      render();
    });
    bar.appendChild(selectAll);
    const applySelected = el("button", { class: "btn primary", type: "button", text: "Apply selected" });
    applySelected.disabled = applying || selected.size === 0;
    applySelected.addEventListener("click", () => {
      runApply([...selected], false);
    });
    const applyAll = el("button", { class: "btn primary", type: "button", text: "Apply all" });
    applyAll.disabled = applying;
    applyAll.addEventListener("click", () => {
      runApply(undefined, true);
    });
    bar.append(applySelected, applyAll);
  }
  return bar;
}

function subtitleText(items: readonly Suggestion[], shown: number): string {
  const pending = pendingCount(items);
  const parts = [`${shown} shown`, `${pending} pending`, `${items.length} total`];
  return parts.join(" · ");
}

export function renderSuggestions(state: AppState): DocumentFragment {
  const frag = document.createDocumentFragment();
  const loaded = suggestionsDoc(state);
  const items = loaded?.suggestions ?? [];
  const catalogKinds = state.doc?.kind === "suggestions" ? state.doc.enums : [];
  const filtered = items.filter(matchesFilters);
  const pendingApplicable = filtered.filter(isApplicable);
  const subtitle = loaded === null ? "Loading…" : subtitleText(items, filtered.length);
  frag.appendChild(pageHead("Suggestions", subtitle, toolbar(pendingApplicable)));
  if (loaded !== null) {
    frag.appendChild(filterBar(items, catalogKinds));
  }
  if (applying) {
    frag.appendChild(el("div", { class: "notice", role: "status", text: "Applying…" }));
  }
  if (loaded === null) {
    if (state.lastError !== null) {
      frag.appendChild(el("div", { class: "notice", text: state.lastError }));
    }
    return frag;
  }
  const list = el("div", { class: "suggestion-list", role: "list" });
  const sorted = [...filtered].sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") {
      return -1;
    }
    if (b.status === "pending" && a.status !== "pending") {
      return 1;
    }
    return b.created.localeCompare(a.created);
  });
  if (items.length === 0) {
    list.appendChild(el("div", { class: "empty", text: "No suggestions yet. Finish a run or click Scan now." }));
  } else if (sorted.length === 0) {
    list.appendChild(el("div", { class: "empty", text: "No suggestions match the current filters." }));
  } else {
    for (const item of sorted) {
      list.appendChild(renderCard(item));
    }
  }
  frag.appendChild(list);
  return frag;
}
