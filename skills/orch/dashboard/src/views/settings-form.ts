import type { Issue } from "../../../shared/types/issue";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import type { ProfilesSettings } from "../../../shared/types/profiles-settings";
import { el } from "../dom/el";
import { saveDoc } from "../forms/document-editor";
import { attachFieldIssues, fieldRow } from "../forms/field-dom";
import type { AppState } from "../state/app-state";

type NumberKey = "retention_days" | "budget_threshold";

const RETENTION_MAX: string = "3650";
const PERCENT_MAX: string = "100";
const NO_PROFILES_LABEL: string = "— no profiles yet —";

// The `settings` block of profiles.json. Its select only offers a blank choice while there is
// nothing to point at: once profiles exist, an empty default is a validation error on disk.
function defaultProfileSelect(draft: ProfilesDocument): HTMLSelectElement {
  const select = el("select", {});
  const names = Object.keys(draft.profiles);
  const current = draft.settings.default_profile ?? "";
  if (names.length === 0) {
    select.appendChild(el("option", { value: "", text: NO_PROFILES_LABEL }));
  }
  // A default naming a profile that is gone stays in the list: saving an untouched form must not
  // silently rewrite the value the user came to fix.
  const options = current !== "" && !names.includes(current) ? [current, ...names] : names;
  for (const name of options) {
    select.appendChild(el("option", { value: name, text: name }));
  }
  select.value = current;
  return select;
}

function numberInput(value: number | undefined, max: string): HTMLInputElement {
  return el("input", {
    type: "number",
    min: "0",
    max,
    step: "1",
    value: value === undefined ? "" : String(value),
  });
}

// An empty box means "not set": the key leaves the document instead of being written as 0.
function writeNumber(settings: ProfilesSettings, key: NumberKey, input: HTMLInputElement): void {
  const text = input.value.trim();
  if (text === "") {
    delete settings[key];
    return;
  }
  settings[key] = Number(text);
}

/**
 * The panel form shown while no profile is open. Every handler writes into `draft` (the whole
 * document the editor holds) and marks the state dirty — none of them re-renders, so typing here
 * is never interrupted by a poll.
 */
export function renderSettingsForm(
  state: AppState,
  draft: ProfilesDocument,
  onIssues: (issues: readonly Issue[]) => void,
): HTMLFormElement {
  const select = defaultProfileSelect(draft);
  const retention = numberInput(draft.settings.retention_days, RETENTION_MAX);
  const budget = numberInput(draft.settings.budget_threshold, PERCENT_MAX);
  const save = el("button", { class: "btn primary", type: "submit", text: "Save" });
  const form = el("form", { class: "form" }, [
    fieldRow("Default profile", select, "settings.default_profile"),
    fieldRow("Retention (days)", retention, "settings.retention_days"),
    fieldRow("Budget threshold (%)", budget, "settings.budget_threshold"),
    el("div", { class: "actions" }, [save]),
  ]);
  select.addEventListener("change", () => {
    draft.settings.default_profile = select.value;
    state.dirty = true;
  });
  retention.addEventListener("input", () => {
    writeNumber(draft.settings, "retention_days", retention);
    state.dirty = true;
  });
  budget.addEventListener("input", () => {
    writeNumber(draft.settings, "budget_threshold", budget);
    state.dirty = true;
  });
  form.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    void saveDoc("profiles", draft, save);
  });
  // Issues from a rejected save: each one that names a control is pinned to it, the rest go back
  // to the panel's top list.
  onIssues(attachFieldIssues(form, state.fieldIssues));
  return form;
}
