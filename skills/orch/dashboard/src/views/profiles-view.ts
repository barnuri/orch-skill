import type { Issue } from "../../../shared/types/issue";
import type { MemoryDocument } from "../../../shared/types/memory-document";
import type { ProfileSpec } from "../../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { chip, el } from "../dom/el";
import { beginEdit } from "../forms/document-editor";
import { deepCopy } from "../forms/field-issues";
import type { AppState } from "../state/app-state";
import { renderDocNotices } from "./doc-notices";
import { renderProfileForm } from "./profile-form";
import { renderSettingsForm } from "./settings-form";

const NEW_TARGET: string = "new";
const CORRUPT_HINT: string = "profiles.json could not be parsed — fix it in an editor and this page picks it up.";
const EMPTY_HINT: string = "No profiles yet. Add one from the panel.";

// memory.json is an array, profiles.json an object — that is the whole difference between the two
// documents the editor slice can be holding.
function asProfilesDocument(value: ProfilesDocument | MemoryDocument | null): ProfilesDocument | null {
  if (value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

// The issues no control claimed (a root-level `$`, or a path under a profile that is not open) are
// listed above the form; the forms hand them over after pinning the rest to their fields.
function issueList(holder: HTMLElement): (issues: readonly Issue[]) => void {
  return (issues: readonly Issue[]): void => {
    holder.replaceChildren();
    if (issues.length === 0) {
      return;
    }
    const list = el("ul", { class: "mono" });
    for (const issue of issues) {
      list.appendChild(el("li", { text: `${issue.path}: ${issue.reason}` }));
    }
    holder.appendChild(el("div", { class: "notice", role: "alert" }, [list]));
  };
}

// The settings form has no EditingTarget of its own: while no profile is open its draft is
// re-seeded from the loaded document on every render, and the first keystroke sets `dirty` —
// which is what stops the 2 s poll from rebuilding the form underneath the user.
function settingsDraft(state: AppState, loaded: ProfilesDocument): ProfilesDocument {
  const current = asProfilesDocument(state.draft);
  if (state.dirty && current !== null) {
    return current;
  }
  const fresh = deepCopy(loaded);
  state.draft = fresh;
  return fresh;
}

function countCell(count: number, noun: string): HTMLElement {
  return el("div", { class: "counts", text: `${count} ${noun}` });
}

function modelCell(spec: ProfileSpec): HTMLElement {
  const model = spec.model ?? "";
  return model === "" ? el("div", { class: "muted", text: "CLI default" }) : el("div", { class: "mono", text: model });
}

function profileRow(state: AppState, loaded: ProfilesDocument, name: string, spec: ProfileSpec): HTMLButtonElement {
  const isDefault = loaded.settings.default_profile === name;
  const selected = state.editing === name;
  const row = el("button", { class: selected ? "doc-row selected" : "doc-row", type: "button" }, [
    el("div", { class: "title" }, [name, isDefault ? chip("default") : null]),
    chip(spec.harness),
    modelCell(spec),
    countCell(spec.flags?.length ?? 0, "flags"),
    countCell(Object.keys(spec.env ?? {}).length, "env"),
    countCell(spec.auth?.length ?? 0, "auth"),
  ]);
  row.addEventListener("click", () => {
    beginEdit(name);
  });
  return row;
}

/** The rows mirror what is on disk (in file order), never the draft — a form is not a list. */
function renderList(state: AppState, loaded: ProfilesDocument): HTMLElement {
  const entries = Object.entries(loaded.profiles);
  if (entries.length === 0) {
    return el("div", { class: "empty", text: EMPTY_HINT });
  }
  const list = el("div", { class: "runs" });
  for (const [name, spec] of entries) {
    list.appendChild(profileRow(state, loaded, name, spec));
  }
  return list;
}

function renderPanel(state: AppState, loaded: ProfilesDocument): HTMLElement {
  const panel = el("aside", { class: "panel" });
  const holder = el("div");
  const onIssues = issueList(holder);
  const draft = asProfilesDocument(state.draft);
  const target = state.editing;
  // A number target belongs to memory.json; without a draft there is nothing to edit either way.
  if (draft !== null && typeof target === "string") {
    panel.appendChild(el("h2", { text: target === NEW_TARGET ? "New profile" : target }));
    panel.appendChild(holder);
    panel.appendChild(renderProfileForm(state, draft, target, onIssues));
    return panel;
  }
  const add = el("button", { class: "btn", type: "button", text: "Add profile" });
  add.addEventListener("click", () => {
    beginEdit(NEW_TARGET);
  });
  panel.appendChild(el("h2", { text: "Settings" }));
  panel.appendChild(holder);
  panel.appendChild(renderSettingsForm(state, settingsDraft(state, loaded), onIssues));
  panel.appendChild(el("div", { class: "actions" }, [add]));
  return panel;
}

function subText(loaded: ProfilesDocument | null, loading: boolean): string {
  if (loading) {
    return "Loading…";
  }
  if (loaded === null) {
    return "profiles.json could not be read.";
  }
  const count = Object.keys(loaded.profiles).length;
  const noun = count === 1 ? "profile" : "profiles";
  const fallback = loaded.settings.default_profile ?? "";
  return `${count} ${noun} · default ${fallback === "" ? "none" : fallback}`;
}

/** The `#/profiles` page body: the profile rows on the left, settings or one profile on the right. */
export function renderProfiles(state: AppState): DocumentFragment {
  const doc = state.doc?.kind === "profiles" ? state.doc : null;
  const loaded = doc === null ? null : asProfilesDocument(doc.document);
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h1", { text: "Profiles" }));
  frag.appendChild(el("div", { class: "sub", text: subText(loaded, doc === null) }));
  // Always in the tree: render.ts swaps this element by id when drift or a save error appears.
  frag.appendChild(renderDocNotices(state));
  if (doc === null) {
    if (state.lastError !== null) {
      frag.appendChild(el("div", { class: "notice", text: `Could not load profiles: ${state.lastError}` }));
    }
    return frag;
  }
  if (loaded === null) {
    frag.appendChild(el("div", { class: "empty", text: CORRUPT_HINT }));
    return frag;
  }
  frag.appendChild(el("div", { class: "layout" }, [renderList(state, loaded), renderPanel(state, loaded)]));
  return frag;
}
