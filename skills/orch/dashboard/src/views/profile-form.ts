import type { Issue } from "../../../shared/types/issue";
import {
  COMPLEXITY_VALUES,
  COST_VALUES,
  QUALITY_VALUES,
  RISK_VALUES,
  SPEED_VALUES,
} from "../../../shared/types/routing-enums";
import {
  isAllowedModelPattern,
  modelAllowEntryMatches,
} from "../../../shared/types/model-pattern";
import type { ProfileSpec } from "../../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { el } from "../dom/el";
import { cancelEdit, saveDoc } from "../forms/document-editor";
import { attachFieldIssues, fieldRow } from "../forms/field-dom";
import { envLinesToObject, linesOf, objectToEnvLines } from "../forms/field-issues";
import type { AppState } from "../state/app-state";
import { render } from "../render";
import { confirmDialog } from "../ui/confirm-dialog";
import { sanityTestButton } from "./profile-sanity";

const NEW_TARGET: string = "new";
const PENDING_KEY: string = "";
const RENAME_HINT: string = "to rename, add a new profile and delete this one";
const DEFAULT_DELETE_HINT: string = "set a different default first";
const DUPLICATE_NAME: string = "a profile with this name already exists";
const FLAGS_HINT: string = "one flag per line";
const ENV_HINT: string = "KEY=VALUE, one per line; a secret must be a ${NAME} reference";
const AUTH_HINT: string = "one auth key per line";
const TAGS_HINT: string = "one tag per line";
const PRIORITY_MAX: string = "10";
const ALLOWED_MODELS_HINT: string =
  "restrict spawn models by catalog id or slug prefix (e.g. llama_swap*); empty = any model for the harness";

let newName: string = "";

function pendingSpec(draft: ProfilesDocument, enums: readonly string[]): ProfileSpec {
  const existing = draft.profiles[PENDING_KEY];
  if (existing !== undefined) {
    return existing;
  }
  newName = "";
  const spec: ProfileSpec = {
    harness: enums[0] ?? "",
    model: "",
    description: "",
    enabled: true,
    flags: [],
    env: {},
    auth: [],
  };
  draft.profiles[PENDING_KEY] = spec;
  return spec;
}

function modelIdsForHarness(draft: ProfilesDocument, harness: string): string[] {
  const models = draft.models ?? {};
  return Object.entries(models)
    .filter(([, modelSpec]) => modelSpec.harnesses.includes(harness))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

function profileNames(draft: ProfilesDocument, exclude: string): string[] {
  return Object.keys(draft.profiles)
    .filter((name) => name !== PENDING_KEY && name !== exclude)
    .sort((a, b) => a.localeCompare(b));
}

function formSection(title: string): HTMLElement {
  return el("h3", { class: "form-section", text: title });
}

function withHint(row: HTMLElement, hint: string): HTMLElement {
  row.appendChild(el("div", { class: "hint", text: hint }));
  return row;
}

function lineArea(text: string, rows: string): HTMLTextAreaElement {
  const area = el("textarea", { rows, spellcheck: "false" });
  area.value = text;
  return area;
}

function enumSelect<T extends string>(
  values: readonly T[],
  current: T | undefined,
  onChange: (value: T | undefined) => void,
): HTMLSelectElement {
  const select = el("select");
  select.appendChild(el("option", { value: "", text: "(unset)" }));
  for (const value of values) {
    select.appendChild(el("option", { value, text: value }));
  }
  select.value = current ?? "";
  select.addEventListener("change", () => {
    onChange(select.value === "" ? undefined : (select.value as T));
  });
  return select;
}

function numberInput(value: number | undefined, max: string): HTMLInputElement {
  const input = el("input", {
    type: "number",
    min: "1",
    max,
    step: "1",
    value: value === undefined ? "" : String(value),
  });
  return input;
}

function checkboxField(
  label: string,
  checked: boolean,
  path: string,
  onChange: (checked: boolean) => void,
): HTMLElement {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.setAttribute("data-path", path);
  const id = `field-${path.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  input.id = id;
  input.addEventListener("change", () => {
    onChange(input.checked);
  });
  const row = el("div", { class: "field field-check" });
  row.append(input, el("label", { for: id, text: label }));
  return row;
}

function writeTags(spec: ProfileSpec, key: "tags" | "strengths" | "avoid_for" | "example_tasks", lines: string): void {
  const items = linesOf(lines);
  if (items.length === 0) {
    delete spec[key];
    return;
  }
  spec[key] = items;
}

/**
 * Offers only what the profile's own `allowed_models` permits — the validator rejects a model
 * outside that list, so listing the rest just invites a save that 400s. The current value is
 * always kept as an option, or an already-invalid profile could not be corrected here.
 */
function selectableModelIds(draft: ProfilesDocument, spec: ProfileSpec): string[] {
  const ids = modelIdsForHarness(draft, spec.harness);
  const entries = spec.allowed_models;
  if (entries === undefined || entries.length === 0) {
    return ids;
  }
  return ids.filter((id) => modelAllowedByEntries(draft, entries, id));
}

function modelSelect(draft: ProfilesDocument, spec: ProfileSpec, base: string, state: AppState): HTMLElement {
  const select = el("select");
  const ids = selectableModelIds(draft, spec);
  select.appendChild(el("option", { value: "", text: "CLI default" }));
  for (const id of ids) {
    select.appendChild(el("option", { value: id, text: id }));
  }
  if (spec.model !== undefined && spec.model !== "" && !ids.includes(spec.model)) {
    select.appendChild(el("option", { value: spec.model, text: `${spec.model} (not allowed)` }));
  }
  select.value = spec.model ?? "";
  select.addEventListener("change", () => {
    spec.model = select.value;
    state.dirty = true;
  });
  return fieldRow("Default model", select, `${base}.model`);
}

function modelAllowedByEntries(
  draft: ProfilesDocument,
  entries: readonly string[],
  id: string,
): boolean {
  const slug = draft.models?.[id]?.slug ?? "";
  return entries.some((entry) => modelAllowEntryMatches(entry, id, slug));
}

function allowedModelsField(
  draft: ProfilesDocument,
  spec: ProfileSpec,
  base: string,
  state: AppState,
): HTMLElement {
  const ids = modelIdsForHarness(draft, spec.harness);
  const wrap = el("div", { class: "field" });
  wrap.appendChild(el("label", { text: "Allowed models" }));
  const anyBox = el("input", { type: "checkbox" });
  anyBox.checked = spec.allowed_models === undefined;
  const anyId = `${base}-allowed-any`;
  anyBox.id = anyId;
  const list = el("div", { class: "check-list" });
  const boxes: HTMLInputElement[] = [];

  const syncVisibility = (): void => {
    list.hidden = anyBox.checked;
  };

  const setAny = (useAny: boolean): void => {
    if (useAny) {
      delete spec.allowed_models;
    } else if (spec.allowed_models === undefined) {
      const defaultModel = spec.model ?? "";
      const first = ids[0] ?? "";
      spec.allowed_models =
        defaultModel !== "" && ids.includes(defaultModel) ? [defaultModel] : first !== "" ? [first] : [];
    }
    state.dirty = true;
    rebuildList();
    syncVisibility();
  };

  const rebuildList = (): void => {
    list.replaceChildren();
    boxes.length = 0;
    const entries = spec.allowed_models ?? [];
    const patterns = entries.filter((entry) => isAllowedModelPattern(entry));
    for (const pattern of patterns) {
      list.appendChild(el("p", { class: "hint mono", text: `pattern: ${pattern}` }));
    }
    for (const id of ids) {
      const box = el("input", { type: "checkbox" });
      box.checked = modelAllowedByEntries(draft, entries, id);
      box.addEventListener("change", () => {
        const patternsNow = (spec.allowed_models ?? []).filter((entry) => isAllowedModelPattern(entry));
        const explicit = new Set(
          (spec.allowed_models ?? []).filter((entry) => !isAllowedModelPattern(entry)),
        );
        if (box.checked) {
          explicit.add(id);
        } else {
          explicit.delete(id);
          for (const pattern of patternsNow) {
            for (const mid of ids) {
              if (mid !== id && modelAllowedByEntries(draft, [pattern], mid)) {
                explicit.add(mid);
              }
            }
          }
        }
        spec.allowed_models = [...explicit].sort((a, b) => a.localeCompare(b));
        state.dirty = true;
        rebuildList();
      });
      boxes.push(box);
      const row = el("div", { class: "check-row" });
      const labelId = `${base}-allowed-${id}`;
      box.id = labelId;
      const slug = draft.models?.[id]?.slug ?? "";
      const label = slug !== "" && slug !== id ? `${id} (${slug})` : id;
      row.append(box, el("label", { for: labelId, text: label }));
      list.appendChild(row);
    }
    if (ids.length === 0) {
      list.appendChild(el("p", { class: "hint", text: "No models in catalog for this harness." }));
    }
  };

  anyBox.addEventListener("change", () => {
    setAny(anyBox.checked);
  });
  wrap.appendChild(el("div", { class: "check-row" }, [anyBox, el("label", { for: anyId, text: "Any model for this harness" })]));
  rebuildList();
  syncVisibility();
  wrap.appendChild(list);
  wrap.setAttribute("data-path", `${base}.allowed_models`);
  return withHint(wrap, ALLOWED_MODELS_HINT);
}

function fallbackSelect(
  draft: ProfilesDocument,
  spec: ProfileSpec,
  profileName: string,
  base: string,
  state: AppState,
): HTMLElement {
  const select = el("select");
  select.appendChild(el("option", { value: "", text: "(none)" }));
  for (const name of profileNames(draft, profileName)) {
    select.appendChild(el("option", { value: name, text: name }));
  }
  const current = spec.fallback ?? "";
  if (current !== "" && !profileNames(draft, profileName).includes(current)) {
    select.appendChild(el("option", { value: current, text: current }));
  }
  select.value = current;
  select.addEventListener("change", () => {
    if (select.value === "") {
      delete spec.fallback;
    } else {
      spec.fallback = select.value;
    }
    state.dirty = true;
  });
  return fieldRow("Fallback profile", select, `${base}.fallback`);
}

function harnessLabel(id: string, harnesses: readonly { id: string; available: boolean; enabled: boolean }[]): string {
  const info = harnesses.find((entry) => entry.id === id);
  if (info === undefined) {
    return id;
  }
  const flags: string[] = [];
  if (!info.enabled) {
    flags.push("disabled in UI");
  }
  if (!info.available) {
    flags.push("not detected");
  }
  return flags.length === 0 ? id : `${id} (${flags.join(", ")})`;
}

function harnessSelect(
  spec: ProfileSpec,
  enums: readonly string[],
  harnesses: readonly { id: string; available: boolean; enabled: boolean }[],
): HTMLSelectElement {
  const select = el("select", {});
  const options = spec.harness !== "" && !enums.includes(spec.harness) ? [spec.harness, ...enums] : [...enums];
  for (const harness of options) {
    select.appendChild(el("option", { value: harness, text: harnessLabel(harness, harnesses) }));
  }
  select.value = spec.harness;
  return select;
}

function nextDocument(draft: ProfilesDocument, name: string, spec: ProfileSpec): ProfilesDocument {
  const profiles: Record<string, ProfileSpec> = {};
  for (const [key, value] of Object.entries(draft.profiles)) {
    if (key !== PENDING_KEY) {
      profiles[key] = value;
    }
  }
  profiles[name] = spec;
  return { settings: draft.settings, models: draft.models ?? {}, profiles };
}

function withoutProfile(draft: ProfilesDocument, name: string): ProfilesDocument {
  const profiles: Record<string, ProfileSpec> = {};
  for (const [key, value] of Object.entries(draft.profiles)) {
    if (key !== PENDING_KEY && key !== name) {
      profiles[key] = value;
    }
  }
  return { settings: draft.settings, models: draft.models ?? {}, profiles };
}

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
  const harnessMeta = state.harnesses ?? enums.map((id) => ({ id, available: true, enabled: true }));
  const harness = harnessSelect(spec, enums, harnessMeta);
  const description = el("textarea", { rows: "3", spellcheck: "true" });
  description.value = spec.description ?? "";
  description.addEventListener("input", () => {
    spec.description = description.value;
    state.dirty = true;
  });
  const descRow = fieldRow("Description", description, `${base}.description`);
  if ((spec.description ?? "") === "") {
    withHint(descRow, "Empty description — routing hint missing (save allowed)");
  }

  const cost = enumSelect(COST_VALUES, spec.cost, (value) => {
    spec.cost = value;
    state.dirty = true;
  });
  const quality = enumSelect(QUALITY_VALUES, spec.quality, (value) => {
    spec.quality = value;
    state.dirty = true;
  });
  const speed = enumSelect(SPEED_VALUES, spec.speed, (value) => {
    spec.speed = value;
    state.dirty = true;
  });
  const risk = enumSelect(RISK_VALUES, spec.risk, (value) => {
    spec.risk = value;
    state.dirty = true;
  });
  const minComplexity = enumSelect(COMPLEXITY_VALUES, spec.min_complexity, (value) => {
    spec.min_complexity = value;
    state.dirty = true;
  });
  const maxComplexity = enumSelect(COMPLEXITY_VALUES, spec.max_complexity, (value) => {
    spec.max_complexity = value;
    state.dirty = true;
  });
  const priority = numberInput(spec.priority, PRIORITY_MAX);
  priority.addEventListener("input", () => {
    const text = priority.value.trim();
    if (text === "") {
      delete spec.priority;
    } else {
      spec.priority = Number(text);
    }
    state.dirty = true;
  });

  const flags = lineArea((spec.flags ?? []).join("\n"), "3");
  const env = lineArea(objectToEnvLines(spec.env ?? {}), "3");
  const auth = lineArea((spec.auth ?? []).join("\n"), "2");
  const tags = lineArea((spec.tags ?? []).join("\n"), "2");
  const strengths = lineArea((spec.strengths ?? []).join("\n"), "2");
  const avoidFor = lineArea((spec.avoid_for ?? []).join("\n"), "2");
  const examples = lineArea((spec.example_tasks ?? []).join("\n"), "2");

  const save = el("button", { class: "btn primary", type: "submit", text: "Save" });
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  const nameRow = fieldRow("Name", nameInput, base);
  if (!isNew) {
    withHint(nameRow, RENAME_HINT);
  }
  const actions = el("div", { class: "actions" }, [save, " ", cancel]);
  if (!isNew) {
    actions.append(" ", sanityTestButton("Sanity test", [target], () => render()));
    actions.append(" ", ...deleteControls(draft, target));
  }

  const form = el("form", { class: "form profile-form" }, [
    formSection("Identity"),
    nameRow,
    fieldRow("Harness", harness, `${base}.harness`),
    descRow,
    checkboxField("Enabled", spec.enabled !== false, `${base}.enabled`, (checked) => {
      spec.enabled = checked;
      state.dirty = true;
    }),
    formSection("Model"),
    modelSelect(draft, spec, base, state),
    allowedModelsField(draft, spec, base, state),
    formSection("Routing"),
    fieldRow("Cost", cost, `${base}.cost`),
    fieldRow("Quality", quality, `${base}.quality`),
    fieldRow("Speed", speed, `${base}.speed`),
    fieldRow("Risk", risk, `${base}.risk`),
    fieldRow("Min complexity", minComplexity, `${base}.min_complexity`),
    fieldRow("Max complexity", maxComplexity, `${base}.max_complexity`),
    fieldRow("Priority (1–10)", priority, `${base}.priority`),
    fallbackSelect(draft, spec, name, base, state),
    checkboxField("Parallel OK", spec.parallel_ok === true, `${base}.parallel_ok`, (checked) => {
      if (checked) {
        spec.parallel_ok = true;
      } else {
        delete spec.parallel_ok;
      }
      state.dirty = true;
    }),
    formSection("Tags & hints"),
    withHint(fieldRow("Tags", tags, `${base}.tags`), TAGS_HINT),
    withHint(fieldRow("Strengths", strengths, `${base}.strengths`), TAGS_HINT),
    withHint(fieldRow("Avoid for", avoidFor, `${base}.avoid_for`), TAGS_HINT),
    withHint(fieldRow("Example tasks", examples, `${base}.example_tasks`), TAGS_HINT),
    formSection("Spawn"),
    withHint(fieldRow("Flags", flags, `${base}.flags`), FLAGS_HINT),
    withHint(fieldRow("Environment", env, `${base}.env`), ENV_HINT),
    withHint(fieldRow("Auth keys", auth, `${base}.auth`), AUTH_HINT),
    actions,
  ]);

  nameInput.addEventListener("input", () => {
    newName = nameInput.value.trim();
    nameInput.setAttribute("data-path", `profiles.${newName}`);
    state.dirty = true;
  });
  harness.addEventListener("change", () => {
    spec.harness = harness.value;
    state.dirty = true;
  });
  flags.addEventListener("input", () => {
    spec.flags = linesOf(flags.value);
    state.dirty = true;
  });
  env.addEventListener("input", () => {
    spec.env = envLinesToObject(env.value, `${base}.env`).env;
    state.dirty = true;
  });
  auth.addEventListener("input", () => {
    spec.auth = linesOf(auth.value);
    state.dirty = true;
  });
  tags.addEventListener("input", () => {
    writeTags(spec, "tags", tags.value);
    state.dirty = true;
  });
  strengths.addEventListener("input", () => {
    writeTags(spec, "strengths", strengths.value);
    state.dirty = true;
  });
  avoidFor.addEventListener("input", () => {
    writeTags(spec, "avoid_for", avoidFor.value);
    state.dirty = true;
  });
  examples.addEventListener("input", () => {
    writeTags(spec, "example_tasks", examples.value);
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
    if (spec.allowed_models !== undefined && spec.allowed_models.length === 0) {
      issues.push({ path: `${base}.allowed_models`, reason: "pick at least one model or allow any" });
    }
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
