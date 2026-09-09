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
import { pageHead } from "./page-head";
import { renderSanityPanel, sanityTestButton } from "./profile-sanity";
import { render } from "../render";
import { renderSettingsForm } from "./settings-form";

const NEW_TARGET: string = "new";
const CORRUPT_HINT: string = "profiles.json could not be parsed — fix it in an editor and this page picks it up.";
const EMPTY_HINT: string = "No profiles yet. Add one from the panel.";

// memory.json is an array, profiles.json an object — that is the whole difference between the two
// documents the editor slice can be holding.
function asProfilesDocument(value: unknown): ProfilesDocument | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  if (!("profiles" in value) || !("settings" in value)) {
    return null;
  }
  return value as ProfilesDocument;
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
  const current = state.doc?.kind === "profiles" ? asProfilesDocument(state.draft) : null;
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

function descCell(spec: ProfileSpec): HTMLElement {
  const text = spec.description ?? "";
  if (text === "") {
    return el("div", { class: "muted", text: "⚠ no description" });
  }
  return el("div", { class: "muted", text: text.length > 48 ? `${text.slice(0, 48)}…` : text });
}

function routingCell(spec: ProfileSpec): HTMLElement {
  const parts: string[] = [];
  if (spec.min_complexity !== undefined || spec.max_complexity !== undefined) {
    parts.push(`${spec.min_complexity ?? "·"}→${spec.max_complexity ?? "·"}`);
  }
  if (spec.allowed_models !== undefined && spec.allowed_models.length > 0) {
    const [only] = spec.allowed_models;
    parts.push(spec.allowed_models.length === 1 && only !== undefined ? only : `${spec.allowed_models.length} models`);
  }
  if (spec.priority !== undefined) {
    parts.push(`p${spec.priority}`);
  }
  if (spec.enabled === false) {
    parts.push("off");
  }
  if (parts.length === 0) {
    return el("div", { class: "muted", text: "—" });
  }
  return el("div", { class: "mono muted", text: parts.join(" · ") });
}

function profileRow(state: AppState, loaded: ProfilesDocument, name: string, spec: ProfileSpec): HTMLButtonElement {
  const isDefault = loaded.settings.default_profile === name;
  const selected = state.editing === name;
  const row = el("button", { class: selected ? "doc-row selected" : "doc-row", type: "button" }, [
    el("div", { class: "title" }, [name, isDefault ? chip("default") : null]),
    chip(spec.harness),
    spec.cost !== undefined ? chip(spec.cost) : el("span"),
    modelCell(spec),
    routingCell(spec),
    descCell(spec),
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
  const editingProfile = typeof state.editing === "string" && state.editing !== "";
  const panel = el("aside", { class: editingProfile ? "panel profile-panel" : "panel" });
  const holder = el("div");
  const onIssues = issueList(holder);
  const draft = state.doc?.kind === "profiles" ? asProfilesDocument(state.draft) : null;
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
  const toolbar = el("div", { class: "toolbar" });
  toolbar.appendChild(sanityTestButton("Sanity test all", undefined, () => render()));
  frag.appendChild(pageHead("Profiles", subText(loaded, doc === null), toolbar));
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
  frag.appendChild(el("div", { class: "layout profile-layout" }, [renderList(state, loaded), renderPanel(state, loaded)]));
  const sanity = renderSanityPanel();
  if (sanity !== null) {
    frag.appendChild(sanity);
  }
  return frag;
}
