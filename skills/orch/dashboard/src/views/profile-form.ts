import type { Issue } from "../../../shared/types/issue";
import type { ProfileSpec } from "../../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { el } from "../dom/el";
import { cancelEdit, saveDoc } from "../forms/document-editor";
import { attachFieldIssues, fieldRow } from "../forms/field-dom";
import { envLinesToObject, linesOf, objectToEnvLines } from "../forms/field-issues";
import type { AppState } from "../state/app-state";
import { confirmDialog } from "../ui/confirm-dialog";

const NEW_TARGET: string = "new";
// The not-yet-saved profile's spec lives in the draft under the empty key: no valid profile name
// is empty, so it can never collide with a real one, and a form rebuilt after a rejected save
// still finds everything the user typed.
const PENDING_KEY: string = "";
const RENAME_HINT: string = "to rename, add a new profile and delete this one";
const DEFAULT_DELETE_HINT: string = "set a different default first";
const DUPLICATE_NAME: string = "a profile with this name already exists";
const FLAGS_HINT: string = "one flag per line";
const ENV_HINT: string = "KEY=VALUE, one per line; a secret must be a ${NAME} reference";
const AUTH_HINT: string = "one auth key per line";

// The pending profile's name. It cannot live in the draft — its key would overwrite a real
// profile the moment the user types an existing name — so the form owns it and drops it whenever
// a fresh "Add profile" starts.
let newName: string = "";

function pendingSpec(draft: ProfilesDocument, enums: readonly string[]): ProfileSpec {
  const existing = draft.profiles[PENDING_KEY];
  if (existing !== undefined) {
    return existing;
  }
  newName = "";
  const spec: ProfileSpec = { harness: enums[0] ?? "", model: "", flags: [], env: {}, auth: [] };
  draft.profiles[PENDING_KEY] = spec;
  return spec;
}

function harnessSelect(spec: ProfileSpec, enums: readonly string[]): HTMLSelectElement {
  const select = el("select", {});
  // A harness the server no longer offers stays selectable so the form does not rewrite it.
  const options = spec.harness !== "" && !enums.includes(spec.harness) ? [spec.harness, ...enums] : [...enums];
  for (const harness of options) {
    select.appendChild(el("option", { value: harness, text: harness }));
  }
  select.value = spec.harness;
  return select;
}

function lineArea(text: string, rows: string): HTMLTextAreaElement {
  const area = el("textarea", { rows, spellcheck: "false" });
  area.value = text;
  return area;
}

function withHint(row: HTMLElement, hint: string): HTMLElement {
  row.appendChild(el("div", { class: "hint", text: hint }));
  return row;
}

/** The whole document as it would go to disk: the pending entry moves under its real name. */
function nextDocument(draft: ProfilesDocument, name: string, spec: ProfileSpec): ProfilesDocument {
  const profiles: Record<string, ProfileSpec> = {};
  for (const [key, value] of Object.entries(draft.profiles)) {
    if (key !== PENDING_KEY) {
      profiles[key] = value;
    }
  }
  profiles[name] = spec;
  return { settings: draft.settings, profiles };
}

function withoutProfile(draft: ProfilesDocument, name: string): ProfilesDocument {
  const profiles: Record<string, ProfileSpec> = {};
  for (const [key, value] of Object.entries(draft.profiles)) {
    if (key !== PENDING_KEY && key !== name) {
      profiles[key] = value;
    }
  }
  return { settings: draft.settings, profiles };
}

// The Delete control, plus the hint that replaces it while this profile is the default: removing
// it would leave `settings.default_profile` dangling and the server rejects the whole document,
// so the guard is here rather than in a failed round trip.
function deleteControls(draft: ProfilesDocument, name: string): Node[] {
  const button = el("button", { class: "btn danger", type: "button", text: "Delete" });
  if (draft.settings.default_profile === name) {
    button.disabled = true;
    return [button, el("div", { class: "hint", text: DEFAULT_DELETE_HINT })];
  }
  button.addEventListener("click", () => {
    void confirmDialog({
      title: `Delete profile ${name}?`,
      body: "Removes it from profiles.json; runs already recorded keep the name.",
      confirmLabel: "Delete",
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        void saveDoc("profiles", withoutProfile(draft, name), button);
      }
    });
  });
  return [button];
}

function missingNotice(target: string): HTMLElement {
  const back = el("button", { class: "btn", type: "button", text: "Back" });
  back.addEventListener("click", () => {
    cancelEdit();
  });
  return el("div", { class: "notice" }, [`Profile ${target} is not in this document any more.`, back]);
}

/**
 * The panel form for one profile — an existing name, or `"new"` for a profile that does not exist
 * yet. Handlers write into `draft` and mark the state dirty; nothing here re-renders, so a poll
 * can never rebuild the form under the user (it raises the drift notice instead).
 */
export function renderProfileForm(
  state: AppState,
  draft: ProfilesDocument,
  target: string,
  onIssues: (issues: readonly Issue[]) => void,
): HTMLElement {
  const isNew = target === NEW_TARGET;
  const enums = state.doc?.enums ?? [];
  const spec = isNew ? pendingSpec(draft, enums) : draft.profiles[target];
  if (spec === undefined) {
    return missingNotice(target);
  }
  const name = isNew ? newName : target;
  const base = `profiles.${name}`;
  const nameInput = el("input", { type: "text", value: name, autocomplete: "off", spellcheck: "false" });
  nameInput.readOnly = !isNew;
  const harness = harnessSelect(spec, enums);
  const model = el("input", { type: "text", value: spec.model ?? "", autocomplete: "off", placeholder: "CLI default" });
  const flags = lineArea((spec.flags ?? []).join("\n"), "3");
  const env = lineArea(objectToEnvLines(spec.env ?? {}), "3");
  const auth = lineArea((spec.auth ?? []).join("\n"), "2");
  const save = el("button", { class: "btn primary", type: "submit", text: "Save" });
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  const nameRow = fieldRow("Name", nameInput, base);
  if (!isNew) {
    withHint(nameRow, RENAME_HINT);
  }
  const actions = el("div", { class: "actions" }, [save, " ", cancel]);
  if (!isNew) {
    // `.actions` is only laid out inside the confirm dialog, so plain spaces keep the buttons apart.
    actions.append(" ", ...deleteControls(draft, target));
  }
  const form = el("form", { class: "form" }, [
    nameRow,
    fieldRow("Harness", harness, `${base}.harness`),
    fieldRow("Model", model, `${base}.model`),
    withHint(fieldRow("Flags", flags, `${base}.flags`), FLAGS_HINT),
    withHint(fieldRow("Environment", env, `${base}.env`), ENV_HINT),
    withHint(fieldRow("Auth keys", auth, `${base}.auth`), AUTH_HINT),
    actions,
  ]);
  nameInput.addEventListener("input", () => {
    newName = nameInput.value.trim();
    // Keeps the control claimable by a local issue on the name the user is typing now; every
    // other path is refreshed by the rebuild that follows a rejected save.
    nameInput.setAttribute("data-path", `profiles.${newName}`);
    state.dirty = true;
  });
  harness.addEventListener("change", () => {
    spec.harness = harness.value;
    state.dirty = true;
  });
  model.addEventListener("input", () => {
    spec.model = model.value;
    state.dirty = true;
  });
  flags.addEventListener("input", () => {
    spec.flags = linesOf(flags.value);
    state.dirty = true;
  });
  env.addEventListener("input", () => {
    // Lines without `=` cannot be represented in the object; they are reported on submit, when
    // the raw text is still in the control.
    spec.env = envLinesToObject(env.value, `${base}.env`).env;
    state.dirty = true;
  });
  auth.addEventListener("input", () => {
    spec.auth = linesOf(auth.value);
    state.dirty = true;
  });
  cancel.addEventListener("click", () => {
    cancelEdit();
  });
  form.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    const typed = isNew ? nameInput.value.trim() : target;
    const parsed = envLinesToObject(env.value, `${base}.env`);
    spec.env = parsed.env;
    const issues: Issue[] = [...parsed.issues];
    if (isNew && typed !== PENDING_KEY && Object.hasOwn(draft.profiles, typed)) {
      issues.push({ path: `profiles.${typed}`, reason: DUPLICATE_NAME });
    }
    // Local checks are reported without a render, so the raw text of a malformed line survives.
    state.fieldIssues = issues;
    onIssues(attachFieldIssues(form, issues));
    if (issues.length > 0) {
      return;
    }
    void saveDoc("profiles", nextDocument(draft, typed, spec), save);
  });
  onIssues(attachFieldIssues(form, state.fieldIssues));
  return form;
}
