import { DOCUMENT_KINDS } from "../../../shared/types/document-kind";
import type { DocumentKind } from "../../../shared/types/document-kind";
import type { Issue } from "../../../shared/types/issue";
import { el } from "../dom/el";
import { cancelEdit } from "../forms/document-editor";
import type { AppState } from "../state/app-state";
import type { EditingTarget } from "../state/editing-target";
import { confirmDialog } from "../ui/confirm-dialog";

const ROOT_ID: string = "doc-notices";
const RELOAD_LABEL: string = "Reload (discards your edits)";

// What the confirm names as the thing being thrown away.
function editingLabel(kind: DocumentKind, editing: EditingTarget): string {
  if (editing === "new") {
    return kind === "profiles" ? "the new profile" : "the new entry";
  }
  if (typeof editing === "number") {
    return `entry #${editing}`;
  }
  if (editing === null) {
    return "this form";
  }
  return `profile "${editing}"`;
}

// Shown while the form is dirty and the file changed underneath it. The form itself is never
// rebuilt here (never-clobber-while-dirty); the user picks between finishing and reloading.
function driftBanner(kind: DocumentKind, editing: EditingTarget): HTMLElement {
  const file = DOCUMENT_KINDS[kind];
  const reload = el("button", { class: "btn", type: "button", text: RELOAD_LABEL });
  reload.addEventListener("click", () => {
    void confirmDialog({
      title: `Reload ${file}?`,
      body: `Discards your unsaved edits to ${editingLabel(kind, editing)} and shows what is now on disk.`,
      confirmLabel: "Reload",
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        cancelEdit();
      }
    });
  });
  return el("div", { class: "notice warn" }, [`${file} changed on disk`, reload]);
}

function errorNotice(message: string): HTMLElement {
  return el("div", { class: "notice", role: "alert", text: message });
}

// Problems the server found in the file as it is on disk. The PUT validator checks the whole
// document, so nothing can be saved from the dashboard until these are fixed (here or in an editor).
function issuesNotice(kind: DocumentKind, issues: readonly Issue[]): HTMLElement {
  const count = issues.length;
  const noun = count === 1 ? "problem" : "problems";
  const list = el("ul", { class: "mono" });
  for (const issue of issues) {
    list.appendChild(el("li", { text: `${issue.path}: ${issue.reason}` }));
  }
  return el("div", { class: "notice" }, [
    el("p", { text: `${DOCUMENT_KINDS[kind]} has ${count} ${noun}; fix them to save from here.` }),
    list,
  ]);
}

// The notice block above a document view. render.ts swaps only this element (by id) when drift
// starts or a local save error appears, so the form and the user's focus stay put.
export function renderDocNotices(state: AppState): HTMLElement {
  const root = el("div", { id: ROOT_ID });
  const doc = state.doc;
  if (doc === null) {
    return root;
  }
  if (state.drift) {
    root.appendChild(driftBanner(doc.kind, state.editing));
  }
  if (state.docError !== null) {
    root.appendChild(errorNotice(state.docError));
  }
  if (doc.issues.length > 0) {
    root.appendChild(issuesNotice(doc.kind, doc.issues));
  }
  return root;
}
