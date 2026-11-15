import { useState } from "react";
import type { FormEvent } from "react";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import type { ProfilesSettings } from "../../shared/types/profiles-settings";
import { Button } from "../components/Button";
import { Select } from "../components/Select";
import type { SelectOption } from "../components/Select";
import { Field, IssueList, IssuesProvider, useMatchedIssues } from "../forms/Field";
import type { DocEditor } from "../forms/use-doc-editor";

type NumberKey = "retention_days" | "budget_threshold" | "max_parallel" | "max_nodes";

const NUMBER_FIELDS: readonly { key: NumberKey; label: string; max: number }[] = [
  { key: "retention_days", label: "Retention (days)", max: 3650 },
  { key: "budget_threshold", label: "Budget threshold (%)", max: 100 },
];
const PLANNING_FIELDS: readonly { key: NumberKey; label: string; max: number }[] = [
  { key: "max_parallel", label: "Max parallel agents", max: 64 },
  { key: "max_nodes", label: "Max planned tasks", max: 200 },
];

// A profile on a disabled harness cannot run, so it is listed but cannot be picked. The current
// choice stays selectable, so saving an untouched form never rewrites the value.
export function profileOptions(doc: ProfilesDocument, current: string, leading: SelectOption[]): SelectOption[] {
  const names = Object.keys(doc.profiles);
  const all = current !== "" && !names.includes(current) ? [current, ...names] : names;
  const off = new Set(doc.settings.disabled_harnesses ?? []);
  return [
    ...leading,
    ...all.map((name) => {
      const harness = doc.profiles[name]?.harness ?? "";
      const harnessOff = harness !== "" && off.has(harness);
      return { value: name, label: harnessOff ? `${name} (${harness} harness is off)` : name, disabled: harnessOff && name !== current };
    }),
  ];
}

/** An empty box means "not set": the key leaves the document instead of being written as 0. */
export function applyNumber(settings: ProfilesSettings, key: NumberKey, text: string): void {
  const trimmed = text.trim();
  if (trimmed === "") {
    delete settings[key];
  } else {
    settings[key] = Number(trimmed);
  }
}

const PATHS = ["default_profile", "retention_days", "budget_threshold", "planner_profile", "max_parallel", "max_nodes"].map((f) => `settings.${f}`);

/**
 * The panel form shown while no profile is open. The draft lives here and marks the editor dirty on
 * the first keystroke, which is what stops a poll from rebuilding the form under the user.
 */
export function SettingsForm({ doc, editor }: { doc: ProfilesDocument; editor: DocEditor }) {
  const [settings, setSettings] = useState<ProfilesSettings>(() => ({ ...doc.settings }));
  const [numbers, setNumbers] = useState<Record<NumberKey, string>>(() => ({
    retention_days: doc.settings.retention_days === undefined ? "" : String(doc.settings.retention_days),
    budget_threshold: doc.settings.budget_threshold === undefined ? "" : String(doc.settings.budget_threshold),
    max_parallel: doc.settings.max_parallel === undefined ? "" : String(doc.settings.max_parallel),
    max_nodes: doc.settings.max_nodes === undefined ? "" : String(doc.settings.max_nodes),
  }));
  const matched = useMatchedIssues(PATHS, editor.fieldIssues);
  const defaultProfile = settings.default_profile ?? "";
  const planner = settings.planner_profile ?? "";

  const numberField = ({ key, label, max }: { key: NumberKey; label: string; max: number }) => (
    <Field key={key} label={label} path={`settings.${key}`}>
      {({ id, invalid }) => (
        <input
          id={id}
          type="number"
          min={0}
          max={max}
          step={1}
          aria-invalid={invalid || undefined}
          value={numbers[key]}
          onChange={(event) => {
            setNumbers((current) => ({ ...current, [key]: event.target.value }));
            editor.markDirty();
          }}
        />
      )}
    </Field>
  );

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next: ProfilesSettings = { ...settings };
    for (const { key } of [...NUMBER_FIELDS, ...PLANNING_FIELDS]) {
      applyNumber(next, key, numbers[key]);
    }
    void editor.save({ ...doc, settings: next });
  };

  return (
    <IssuesProvider value={matched}>
      <form className="form" onSubmit={submit}>
        <IssueList issues={matched.unmatched} />
        <Field label="Default profile" path="settings.default_profile">
          {({ id, invalid }) => (
            <Select
              id={id}
              invalid={invalid}
              value={defaultProfile}
              options={profileOptions(doc, defaultProfile, Object.keys(doc.profiles).length === 0 ? [{ value: "", label: "— no profiles yet —" }] : [])}
              onChange={(value) => {
                setSettings((current) => ({ ...current, default_profile: value }));
                editor.markDirty();
              }}
            />
          )}
        </Field>
        {NUMBER_FIELDS.map(numberField)}
        <Field label="Planner profile" path="settings.planner_profile">
          {({ id, invalid }) => (
            <Select
              id={id}
              invalid={invalid}
              value={planner}
              options={profileOptions(doc, planner, [{ value: "", label: "— none —" }])}
              onChange={(value) => {
                setSettings((current) => {
                  const next = { ...current };
                  if (value === "") {
                    delete next.planner_profile;
                  } else {
                    next.planner_profile = value;
                  }
                  return next;
                });
                editor.markDirty();
              }}
            />
          )}
        </Field>
        {PLANNING_FIELDS.map(numberField)}
        <div className="actions">
          <Button variant="primary" type="submit" disabled={editor.saving}>
            Save
          </Button>
        </div>
      </form>
    </IssuesProvider>
  );
}
