import { DOCUMENT_KINDS } from "../../../shared/types/document-kind";
import type { DocumentKind } from "../../../shared/types/document-kind";
import type { PutOk } from "../../../shared/types/put-ok";
import { ApiClient } from "../api/api-client";
import type { ApiResult } from "../api/api-result";
import { poll } from "../poll";
import { render, renderDocNotices } from "../render";
import type { EditingTarget } from "../state/editing-target";
import { state } from "../state/state";
import { toast } from "../ui/toast";
import { deepCopy } from "./field-issues";

const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_PRECONDITION_FAILED = 412;
const NETWORK_ERROR: string = "cannot reach the server — nothing was saved";
const STALE_SAVED: string = "Changed on disk by another session — reloaded, redo your edit";

const api = new ApiClient();

// One PUT at a time: a second submit while the first is in flight is dropped, not queued.
let saving = false;

// Re-fetches the current document through the poll path so the latest-poll guard and the
// applyDocLoad rules apply exactly as for a timer tick (a changed etag → 200 → rebuild; the same
// etag → 304 → nothing). Loads are never optimistic: the server's answer is the document.
export function loadDoc(kind: DocumentKind): Promise<void> {
  if (state.route.kind !== kind) {
    return Promise.resolve();
  }
  return poll();
}

function clearEditing(): void {
  state.editing = null;
  state.draft = null;
  state.dirty = false;
  state.fieldIssues = [];
  state.docError = null;
}

// Opens a form on `target` with a private copy of the loaded document; input handlers mutate the
// copy and set `dirty`, nothing touches `state.doc`. No-op against a corrupt/missing file (the
// on-disk issues notice explains why) or when that target is already open.
export function beginEdit(target: EditingTarget): void {
  const loaded = state.doc?.document ?? null;
  if (loaded === null || state.editing === target) {
    return;
  }
  clearEditing();
  state.editing = target;
  state.draft = deepCopy(loaded);
  render();
}

// Drops the draft. If the file drifted while the user was typing, the now-clean slice adopts
// the on-disk version straight away instead of waiting for the next tick.
export function cancelEdit(): void {
  const kind = state.doc?.kind;
  const drifted = state.drift;
  clearEditing();
  state.drift = false;
  render();
  if (drifted && kind !== undefined) {
    void loadDoc(kind);
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function applyPutResult(kind: DocumentKind, result: ApiResult<PutOk>): void {
  if (result.kind === "ok") {
    clearEditing();
    toast("ok", `Saved ${DOCUMENT_KINDS[kind]}`);
    render();
    void loadDoc(kind);
    return;
  }
  // Every branch below repaints: saveDoc cleared `docError`/`fieldIssues` before the request, so
  // skipping render() here would leave a previous attempt's notice and red fields on screen.
  if (result.kind === "network") {
    toast("error", NETWORK_ERROR);
    render();
    return;
  }
  if (result.kind === "unchanged") {
    // A PUT never 304s; treat it like any other unexpected answer.
    toast("error", "unexpected 304 on save");
    render();
    return;
  }
  if (result.status === HTTP_STATUS_BAD_REQUEST) {
    // Validation failed: stay in the form, the view pins `fieldIssues` to controls by data-path.
    state.fieldIssues = result.body?.issues ?? [];
    state.docError = result.body?.error ?? `HTTP ${result.status}`;
    render();
    return;
  }
  if (result.status === HTTP_STATUS_PRECONDITION_FAILED) {
    toast("error", STALE_SAVED);
    clearEditing();
    render();
    void loadDoc(kind);
    return;
  }
  if (result.status === HTTP_STATUS_UNAUTHORIZED) {
    // The gate replaces <main>; the draft stays so the form comes back intact after the token.
    state.authRequired = true;
    render();
    return;
  }
  toast("error", result.body?.error ?? `HTTP ${result.status}`);
  render();
}

// PUTs `next` (the whole document the form assembled) with If-Match on the loaded etag. Size is
// pre-checked locally against the server's advertised limit so an oversize body never leaves the
// page. `saveButton`, when given, is disabled for the round trip and always re-enabled.
export async function saveDoc(kind: DocumentKind, next: unknown, saveButton?: HTMLButtonElement): Promise<void> {
  const doc = state.doc;
  if (saving || doc === null || doc.kind !== kind) {
    return;
  }
  state.docError = null;
  state.fieldIssues = [];
  const bytes = byteLength(next);
  if (bytes > doc.maxBodyBytes) {
    state.docError = `document is ${bytes} bytes; the server accepts at most ${doc.maxBodyBytes}`;
    // Full render, not just the notices: the cleared fieldIssues must drop their field markers too.
    render();
    return;
  }
  saving = true;
  if (saveButton !== undefined) {
    saveButton.disabled = true;
  }
  try {
    const result = await api.putDocument(kind, next, doc.etag);
    applyPutResult(kind, result);
  } finally {
    saving = false;
    if (saveButton !== undefined) {
      saveButton.disabled = false;
    }
  }
}
