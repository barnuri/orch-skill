import type { MemoryDocument } from "../../../shared/types/memory-document";
import type { MemoryEntry } from "../../../shared/types/memory-entry";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { chip, el } from "../dom/el";
import { fmtTime, nowIso, truncate } from "../dom/format";
import { beginEdit } from "../forms/document-editor";
import type { AppState } from "../state/app-state";
import { renderDocNotices } from "./doc-notices";
import { renderMemoryForm } from "./memory-form";
import { pageHead } from "./page-head";

type IndexedEntry = { index: number; entry: MemoryEntry };

const NOTE_MAX = 72;
const ADD_LABEL: string = "Add entry";
const CORRUPT_HINT: string = "memory.json could not be parsed — fix it in an editor and this page picks it up.";

// The not-yet-saved entry behind `editing === "new"`. It lives here rather than in `state.draft`
// (which always mirrors the whole document) so that a re-render — a rejected save, a drift
// notice — rebuilds the form around the same object instead of discarding what was typed.
let pending: MemoryEntry | null = null;

// Pinned "Add entry" prefill. `default_profile` comes from the last profiles load — like
// `profileNames`, it survives a route change precisely so `#/memory` can use it — which keeps the
// common case off a guaranteed 400 (the server rejects an empty `profile`).
function newEntry(outcomes: readonly string[], defaultProfile: string): MemoryEntry {
  return {
    ts: nowIso(),
    task_kind: "",
    profile: defaultProfile,
    harness: "",
    model: "",
    outcome: outcomes[0] ?? "",
    note: "",
  };
}

function memoryEntries(document: ProfilesDocument | MemoryDocument | null): MemoryEntry[] {
  return Array.isArray(document) ? document : [];
}

function draftEntries(state: AppState): MemoryEntry[] {
  if (state.doc?.kind !== "memory" || !Array.isArray(state.draft)) {
    return [];
  }
  return state.draft;
}

/** Newest first — the file grows at the end — while every row keeps its real array index. */
function newestFirst(entries: readonly MemoryEntry[]): IndexedEntry[] {
  return entries.map((entry, index) => ({ index, entry })).reverse();
}

function renderRow(item: IndexedEntry, selected: boolean): HTMLElement {
  const { entry, index } = item;
  const row = el("button", { class: selected ? "doc-row selected" : "doc-row", type: "button" }, [
    el("div", { class: "title", text: fmtTime(entry.ts) }),
    el("div", { class: "mono", text: entry.profile }),
    chip(entry.outcome),
    el("div", { class: "muted", text: entry.task_kind ?? "" }),
    el("div", { class: "muted", text: truncate(entry.note ?? "", NOTE_MAX) }),
  ]);
  row.addEventListener("click", () => {
    beginEdit(index);
  });
  return row;
}

function renderList(state: AppState, entries: readonly MemoryEntry[]): HTMLElement {
  if (entries.length === 0) {
    return el("div", { class: "empty" }, [
      "No entries yet. Record one here, or with ",
      el("code", { text: "dispatch.sh memory add --profile <name> --outcome success" }),
      ".",
    ]);
  }
  const list = el("div", { class: "runs", role: "list" });
  for (const item of newestFirst(entries)) {
    list.appendChild(renderRow(item, state.editing === item.index));
  }
  return list;
}

function renderAddPanel(state: AppState): HTMLElement {
  const add = el("button", { class: "btn primary", type: "button", text: ADD_LABEL });
  add.addEventListener("click", () => {
    pending = newEntry(state.doc?.enums ?? [], state.defaultProfile);
    beginEdit("new");
  });
  return el("aside", { class: "panel" }, [
    el("h2", { text: "Memory" }),
    el("p", { class: "hint", text: "Pick an entry to edit it, or record what a run taught you." }),
    add,
  ]);
}

// Forms edit `state.draft` (the private copy beginEdit made), never the loaded document the rows
// are drawn from; both share the same indexes, so a row index addresses the draft entry directly.
function renderPanel(state: AppState): HTMLElement {
  const draft = draftEntries(state);
  if (state.editing === "new" && pending !== null) {
    return el("aside", { class: "panel" }, [renderMemoryForm("new", pending, state)]);
  }
  if (typeof state.editing === "number") {
    const entry = draft[state.editing];
    if (entry !== undefined) {
      return el("aside", { class: "panel" }, [renderMemoryForm(state.editing, entry, state)]);
    }
  }
  return renderAddPanel(state);
}

/** The `#/memory` page body. Crumb and `document.title` are set by `render()`, not here. */
export function renderMemory(state: AppState): DocumentFragment {
  if (state.editing !== "new") {
    pending = null;
  }
  // Three states the row list cannot express: not loaded, loaded-but-corrupt, and really empty.
  // Only the last one may show the Add button — beginEdit is a no-op without a loaded document.
  const doc = state.doc?.kind === "memory" ? state.doc : null;
  const loaded = doc === null || !Array.isArray(doc.document) ? null : doc.document;
  const entries = loaded ?? [];
  const frag = document.createDocumentFragment();
  const noun = entries.length === 1 ? "entry" : "entries";
  const sub = doc === null ? "Loading…" : loaded === null ? "memory.json could not be read." : `${entries.length} ${noun} · newest first`;
  frag.appendChild(pageHead("Memory", sub));
  frag.appendChild(renderDocNotices(state));
  if (doc === null) {
    if (state.lastError !== null) {
      frag.appendChild(el("div", { class: "notice", text: `Could not load memory: ${state.lastError}` }));
    }
    return frag;
  }
  if (loaded === null) {
    frag.appendChild(el("div", { class: "empty", text: CORRUPT_HINT }));
    return frag;
  }
  frag.appendChild(el("div", { class: "layout" }, [renderList(state, entries), renderPanel(state)]));
  return frag;
}
