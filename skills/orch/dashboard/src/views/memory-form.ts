import type { Issue } from "../../../shared/types/issue";
import type { MemoryEntry } from "../../../shared/types/memory-entry";
import { el } from "../dom/el";
import { cancelEdit, saveDoc } from "../forms/document-editor";
import type { FieldControl } from "../forms/field-dom";
import { attachFieldIssues, fieldRow } from "../forms/field-dom";
import type { AppState } from "../state/app-state";
import { confirmDialog } from "../ui/confirm-dialog";

/** An array index into memory.json, or the entry that is not on disk yet. */
export type MemoryFormTarget = number | "new";

const PROFILES_LIST_ID: string = "memory-profiles";
const NOTE_ROWS: string = "4";
const NO_PROFILE: string = "(no profile)";

function draftEntries(state: AppState): MemoryEntry[] {
  if (state.doc?.kind !== "memory" || !Array.isArray(state.draft)) {
    return [];
  }
  return state.draft;
}

// Where the server will report issues about this entry: a new one lands at the end of the array,
// which is also where `memory add` appends.
function entryIndex(state: AppState, target: MemoryFormTarget): number {
  return target === "new" ? draftEntries(state).length : target;
}

// The whole document the PUT carries: an existing entry is already the draft's own object (the
// controls edit it in place), a new one is appended.
function nextDocument(state: AppState, target: MemoryFormTarget, entry: MemoryEntry): MemoryEntry[] {
  const entries = draftEntries(state);
  return target === "new" ? [...entries, entry] : entries;
}

function bind(control: FieldControl, state: AppState, assign: (value: string) => void): void {
  control.addEventListener("input", () => {
    assign(control.value);
    // Render discipline: input handlers only mark the draft dirty — they never re-render, so the
    // control the user is typing into is never rebuilt underneath them.
    state.dirty = true;
  });
}

function textField(
  label: string,
  path: string,
  value: string,
  state: AppState,
  assign: (value: string) => void,
): HTMLElement {
  const input = el("input", { type: "text", autocomplete: "off", spellcheck: "false" });
  input.value = value;
  bind(input, state, assign);
  return fieldRow(label, input, path);
}

// `ts` identifies the entry (the confirm and the row both name it) and the CLI wrote it, so the
// form shows it and never lets it change.
function timestampField(path: string, value: string): HTMLElement {
  const input = el("input", { class: "mono", type: "text", readonly: "", "aria-readonly": "true" });
  input.value = value;
  return fieldRow("Recorded", input, path);
}

function profileField(path: string, entry: MemoryEntry, state: AppState): HTMLElement {
  const input = el("input", {
    type: "text",
    list: PROFILES_LIST_ID,
    autocomplete: "off",
    spellcheck: "false",
  });
  input.value = entry.profile;
  bind(input, state, (value) => {
    entry.profile = value;
  });
  return fieldRow("Profile", input, path);
}

// Suggestions only — memory keeps the profile a run used even after that profile is deleted, so
// the control stays a free-text input.
function profilesDatalist(names: readonly string[]): HTMLDataListElement {
  const list = el("datalist", { id: PROFILES_LIST_ID });
  for (const name of names) {
    list.appendChild(el("option", { value: name }));
  }
  return list;
}

function outcomeField(path: string, entry: MemoryEntry, state: AppState): HTMLElement {
  const outcomes = state.doc?.enums ?? [];
  // A value the server does not accept (or a still-empty one) is offered too, so opening the form
  // never silently rewrites what is on disk; saving it draws the validator's issue on this field.
  const values = outcomes.includes(entry.outcome) ? outcomes : [entry.outcome, ...outcomes];
  const select = el("select");
  for (const value of values) {
    select.appendChild(el("option", { value, text: value }));
  }
  select.value = entry.outcome;
  bind(select, state, (value) => {
    entry.outcome = value;
  });
  return fieldRow("Outcome", select, path);
}

function noteField(path: string, entry: MemoryEntry, state: AppState): HTMLElement {
  const note = el("textarea", { rows: NOTE_ROWS });
  note.value = entry.note ?? "";
  bind(note, state, (value) => {
    entry.note = value;
  });
  return fieldRow("Note", note, path);
}

function deleteButton(state: AppState, index: number, entry: MemoryEntry): HTMLButtonElement {
  const button = el("button", { class: "btn danger", type: "button", text: "Delete" });
  button.addEventListener("click", () => {
    void confirmDialog({
      title: `Delete the ${entry.profile || NO_PROFILE} entry from ${entry.ts}?`,
      body: "Removes it from memory.json; the run it describes is untouched.",
      confirmLabel: "Delete",
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      void saveDoc(
        "memory",
        draftEntries(state).filter((_, at) => at !== index),
        button,
      );
    });
  });
  return button;
}

// Issues the validator reported against something no control owns (the array itself, another
// entry) are listed above the fields; attachFieldIssues pinned the rest to their controls.
function attachIssues(form: HTMLFormElement, issues: readonly Issue[]): void {
  const unmatched = attachFieldIssues(form, issues);
  if (unmatched.length === 0) {
    return;
  }
  const list = el("ul", { class: "mono" });
  for (const issue of unmatched) {
    list.appendChild(el("li", { text: `${issue.path}: ${issue.reason}` }));
  }
  form.prepend(el("div", { class: "notice" }, [list]));
}

/**
 * The memory editor panel. `entry` is the object the controls mutate: the draft's entry at
 * `target` for an existing row, the view's pending entry for `"new"` (which has no Delete —
 * there is nothing on disk to remove; Cancel drops it).
 */
export function renderMemoryForm(target: MemoryFormTarget, entry: MemoryEntry, state: AppState): HTMLFormElement {
  const index = entryIndex(state, target);
  const pathOf = (field: string): string => `memory[${index}].${field}`;
  const save = el("button", { class: "btn primary", type: "submit", text: "Save" });
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  cancel.addEventListener("click", () => {
    cancelEdit();
  });
  const buttons = el("div", { class: "actions" }, [save, " ", cancel]);
  if (typeof target === "number") {
    buttons.append(" ", deleteButton(state, target, entry));
  }
  const form = el("form", { class: "form" }, [
    el("h2", { text: target === "new" ? "New entry" : "Edit entry" }),
    timestampField(pathOf("ts"), entry.ts),
    profileField(pathOf("profile"), entry, state),
    outcomeField(pathOf("outcome"), entry, state),
    textField("Task kind", pathOf("task_kind"), entry.task_kind ?? "", state, (value) => {
      entry.task_kind = value;
    }),
    textField("Harness", pathOf("harness"), entry.harness ?? "", state, (value) => {
      entry.harness = value;
    }),
    textField("Model", pathOf("model"), entry.model ?? "", state, (value) => {
      entry.model = value;
    }),
    noteField(pathOf("note"), entry, state),
    profilesDatalist(state.profileNames),
    buttons,
  ]);
  form.addEventListener("submit", (event: SubmitEvent) => {
    // Nothing ever navigates: the whole document goes out as a PUT with If-Match.
    event.preventDefault();
    void saveDoc("memory", nextDocument(state, target, entry), save);
  });
  attachIssues(form, state.fieldIssues);
  return form;
}
