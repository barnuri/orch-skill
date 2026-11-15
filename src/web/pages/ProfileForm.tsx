import { useState } from "react";
import type { FormEvent } from "react";
import type { Issue } from "../../shared/types/issue";
import type { ProfileSpec } from "../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import { COMPLEXITY_VALUES, COST_VALUES, QUALITY_VALUES, RISK_VALUES, SPEED_VALUES } from "../../shared/types/routing-enums";
import { isAllowedModelPattern } from "../../shared/types/model-pattern";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { useConfirm } from "../components/ConfirmDialog";
import { Select } from "../components/Select";
import type { SelectOption } from "../components/Select";
import { Field, FieldErrors, IssueList, IssuesProvider, useMatchedIssues } from "../forms/Field";
import type { DocEditor } from "../forms/use-doc-editor";
import { queryClient, keys } from "../api/queries";
import type { HarnessStatus } from "../../shared/types/harness-status";
import {
  allowedByEntries,
  modelIdsForHarness,
  selectableModelIds,
  setAnyModels,
  toggleAllowedModel,
} from "../lib/allowed-models";
import { envLinesToObject, linesOf, objectToEnvLines } from "../lib/field-issues";
import { SanityTestButton } from "./SanityPanel";

const NEW_TARGET = "new";
const RENAME_HINT = "to rename, add a new profile and delete this one";
const DEFAULT_DELETE_HINT = "set a different default first";
const DUPLICATE_NAME = "a profile with this name already exists";
const LINE_HINTS = {
  flags: "one flag per line",
  env: "KEY=VALUE, one per line; a secret must be a ${NAME} reference",
  auth: "one auth key per line",
  tags: "one tag per line",
} as const;
const ALLOWED_MODELS_HINT = "restrict spawn models by catalog id or slug prefix (e.g. llama_swap*); empty = any model for the harness";

type LineKey = "flags" | "auth" | "tags" | "strengths" | "avoid_for" | "example_tasks";
type EnumKey = "cost" | "quality" | "speed" | "risk" | "min_complexity" | "max_complexity";

const FIELD_NAMES = [
  "harness", "description", "enabled", "model", "allowed_models", "cost", "quality", "speed", "risk", "min_complexity",
  "max_complexity", "priority", "fallback", "parallel_ok", "tags", "strengths", "avoid_for", "example_tasks", "flags", "env", "auth",
];

const ENUM_FIELDS: readonly { key: EnumKey; label: string; values: readonly string[] }[] = [
  { key: "cost", label: "Cost", values: COST_VALUES },
  { key: "quality", label: "Quality", values: QUALITY_VALUES },
  { key: "speed", label: "Speed", values: SPEED_VALUES },
  { key: "risk", label: "Risk", values: RISK_VALUES },
  { key: "min_complexity", label: "Min complexity", values: COMPLEXITY_VALUES },
  { key: "max_complexity", label: "Max complexity", values: COMPLEXITY_VALUES },
];

const unsetOr = (values: readonly string[]): SelectOption[] => [
  { value: "", label: "(unset)" },
  ...values.map((value) => ({ value, label: value })),
];

export function harnessLabel(id: string, harnesses: readonly Pick<HarnessStatus, "id" | "available" | "enabled">[]): string {
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

function FormSection({ title }: { title: string }) {
  return <h3 className="form-section">{title}</h3>;
}

/** The profile editor: `target` is a profile name, or "new" for one that is not on disk yet. */
export function ProfileForm({ doc, target, enums, editor }: { doc: ProfilesDocument; target: string; enums: readonly string[]; editor: DocEditor }) {
  const confirm = useConfirm();
  const isNew = target === NEW_TARGET;
  const existing = isNew ? undefined : doc.profiles[target];
  const [spec, setSpec] = useState<ProfileSpec | null>(() =>
    isNew
      ? { harness: enums[0] ?? "", model: "", description: "", enabled: true, flags: [], env: {}, auth: [] }
      : existing === undefined
        ? null
        : structuredClone(existing),
  );
  const [name, setName] = useState("");
  const [lines, setLines] = useState<Record<LineKey | "env", string>>(() => ({
    flags: (spec?.flags ?? []).join("\n"),
    env: objectToEnvLines(spec?.env ?? {}),
    auth: (spec?.auth ?? []).join("\n"),
    tags: (spec?.tags ?? []).join("\n"),
    strengths: (spec?.strengths ?? []).join("\n"),
    avoid_for: (spec?.avoid_for ?? []).join("\n"),
    example_tasks: (spec?.example_tasks ?? []).join("\n"),
  }));
  const [localIssues, setLocalIssues] = useState<readonly Issue[]>([]);
  const base = `profiles.${isNew ? name : target}`;
  const paths = [base, ...FIELD_NAMES.map((field) => `${base}.${field}`)];
  const matched = useMatchedIssues(paths, [...localIssues, ...editor.fieldIssues]);
  const harnesses = queryClient.getQueryData<{ harnesses: HarnessStatus[] }>([keys.harnesses])?.harnesses ?? enums.map((id) => ({ id, available: true, enabled: true }));
  const models = doc.models ?? {};

  if (spec === null) {
    return (
      <div className="notice">
        {`Profile ${target} is not in this document any more.`}
        <Button onClick={editor.cancel}>Back</Button>
      </div>
    );
  }
  const update = (patch: Partial<ProfileSpec>): void => {
    setSpec((current) => (current === null ? current : { ...current, ...patch }));
    editor.markDirty();
  };
  const remove = (key: keyof ProfileSpec): void => {
    setSpec((current) => {
      if (current === null) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    editor.markDirty();
  };
  const setLine = (key: LineKey | "env", text: string): void => {
    setLines((current) => ({ ...current, [key]: text }));
    if (key === "env") {
      update({ env: envLinesToObject(text, `${base}.env`).env });
    } else if (key === "flags" || key === "auth") {
      update({ [key]: linesOf(text) });
    } else {
      const items = linesOf(text);
      if (items.length === 0) {
        remove(key);
      } else {
        update({ [key]: items });
      }
    }
  };

  const harnessOff = (doc.settings.disabled_harnesses ?? []).includes(spec.harness);
  const harnessIds = spec.harness !== "" && !enums.includes(spec.harness) ? [spec.harness, ...enums] : [...enums];
  const modelIds = modelIdsForHarness(models, spec.harness);
  const selectable = selectableModelIds(models, spec);
  const modelOptions: SelectOption[] = [
    { value: "", label: "CLI default" },
    ...selectable.map((id) => ({ value: id, label: id })),
    ...(spec.model !== undefined && spec.model !== "" && !selectable.includes(spec.model) ? [{ value: spec.model, label: `${spec.model} (not allowed)` }] : []),
  ];
  const others = Object.keys(doc.profiles).filter((p) => p !== target).sort((a, b) => a.localeCompare(b));
  const fallback = spec.fallback ?? "";
  const fallbackOptions: SelectOption[] = [
    { value: "", label: "(none)" },
    ...(fallback !== "" && !others.includes(fallback) ? [fallback] : []).concat(others).map((p) => ({ value: p, label: p })),
  ];
  const allowed = spec.allowed_models;
  const patterns = (allowed ?? []).filter((entry) => isAllowedModelPattern(entry));

  const buildDocument = (typed: string, finalSpec: ProfileSpec): ProfilesDocument => {
    const profiles: Record<string, ProfileSpec> = {};
    for (const [key, value] of Object.entries(doc.profiles)) {
      profiles[key] = key === typed ? finalSpec : value;
    }
    profiles[typed] = finalSpec;
    return { settings: doc.settings, models: doc.models ?? {}, profiles };
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const typed = isNew ? name.trim() : target;
    const parsed = envLinesToObject(lines.env, `${base}.env`);
    const finalSpec: ProfileSpec = { ...spec, env: parsed.env };
    const issues: Issue[] = [...parsed.issues];
    if (isNew && typed !== "" && Object.hasOwn(doc.profiles, typed)) {
      issues.push({ path: `profiles.${typed}`, reason: DUPLICATE_NAME });
    }
    if (finalSpec.allowed_models !== undefined && finalSpec.allowed_models.length === 0) {
      issues.push({ path: `${base}.allowed_models`, reason: "pick at least one model or allow any" });
    }
    setLocalIssues(issues);
    if (issues.length > 0) {
      return;
    }
    void editor.save(buildDocument(typed, finalSpec));
  };
  const onDelete = (): void => {
    void confirm({
      title: `Delete profile ${target}?`,
      body: "Removes it from profiles.json; runs already recorded keep the name.",
      confirmLabel: "Delete",
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        const profiles = Object.fromEntries(Object.entries(doc.profiles).filter(([key]) => key !== target));
        void editor.save({ settings: doc.settings, models: doc.models ?? {}, profiles });
      }
    });
  };
  const lineField = (key: LineKey, label: string, rows: number, hint: string) => (
    <Field label={label} path={`${base}.${key}`} hint={hint}>
      {({ id, invalid }) => (
        <textarea
          id={id}
          rows={rows}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          value={lines[key]}
          onChange={(event) => {
            setLine(key, event.target.value);
          }}
        />
      )}
    </Field>
  );

  return (
    <IssuesProvider value={matched}>
      <form className="form profile-form" onSubmit={submit}>
        <IssueList issues={matched.unmatched} />
        <FormSection title="Identity" />
        <Field label="Name" path={base} hint={isNew ? undefined : RENAME_HINT}>
          {({ id, invalid }) => (
            <input
              id={id}
              type="text"
              autoComplete="off"
              spellCheck={false}
              readOnly={!isNew}
              aria-invalid={invalid || undefined}
              value={isNew ? name : target}
              onChange={(event) => {
                setName(event.target.value);
                editor.markDirty();
              }}
            />
          )}
        </Field>
        <Field label="Harness" path={`${base}.harness`}>
          {({ id, invalid }) => (
            <Select
              id={id}
              invalid={invalid}
              value={spec.harness}
              options={harnessIds.map((harness) => ({ value: harness, label: harnessLabel(harness, harnesses) }))}
              onChange={(harness) => {
                update({ harness });
              }}
            />
          )}
        </Field>
        <Field label="Description" path={`${base}.description`} hint={(spec.description ?? "") === "" ? "Empty description — routing hint missing (save allowed)" : undefined}>
          {({ id, invalid }) => (
            <textarea
              id={id}
              rows={3}
              spellCheck
              aria-invalid={invalid || undefined}
              value={spec.description ?? ""}
              onChange={(event) => {
                update({ description: event.target.value });
              }}
            />
          )}
        </Field>
        <div className="field field-check" data-path={`${base}.enabled`}>
          <Checkbox
            label="Enabled"
            checked={spec.enabled !== false && !harnessOff}
            disabled={harnessOff}
            onChange={(enabled) => {
              update({ enabled });
            }}
          />
          {harnessOff ? <span className="hint">{`The ${spec.harness} harness is disabled. Enable it on the Harnesses page first.`}</span> : null}
          <FieldErrors path={`${base}.enabled`} />
        </div>
        <FormSection title="Model" />
        <Field label="Default model" path={`${base}.model`}>
          {({ id, invalid }) => (
            <Select
              id={id}
              invalid={invalid}
              value={spec.model ?? ""}
              options={modelOptions}
              onChange={(model) => {
                update({ model });
              }}
            />
          )}
        </Field>
        <div className="field" data-path={`${base}.allowed_models`}>
          <label>Allowed models</label>
          <div className="check-row">
            <Checkbox
              label="Any model for this harness"
              checked={allowed === undefined}
              onChange={(useAny) => {
                const next = setAnyModels(spec, useAny, modelIds);
                if (next === undefined) {
                  remove("allowed_models");
                } else {
                  update({ allowed_models: next });
                }
              }}
            />
          </div>
          <div className="check-list" hidden={allowed === undefined}>
            {patterns.map((pattern) => (
              <p key={pattern} className="hint mono">{`pattern: ${pattern}`}</p>
            ))}
            {modelIds.map((id) => {
              const slug = models[id]?.slug ?? "";
              return (
                <div key={id} className="check-row">
                  <Checkbox
                    label={slug !== "" && slug !== id ? `${id} (${slug})` : id}
                    checked={allowedByEntries(models, allowed ?? [], id)}
                    onChange={(checked) => {
                      update({ allowed_models: toggleAllowedModel(allowed ?? [], id, checked, modelIds, models) });
                    }}
                  />
                </div>
              );
            })}
            {modelIds.length === 0 ? <p className="hint">No models in catalog for this harness.</p> : null}
          </div>
          <div className="hint">{ALLOWED_MODELS_HINT}</div>
          <FieldErrors path={`${base}.allowed_models`} />
        </div>
        <FormSection title="Routing" />
        {ENUM_FIELDS.map(({ key, label, values }) => (
          <Field key={key} label={label} path={`${base}.${key}`}>
            {({ id, invalid }) => (
              <Select
                id={id}
                invalid={invalid}
                value={spec[key] ?? ""}
                options={unsetOr(values)}
                onChange={(value) => {
                  if (value === "") {
                    remove(key);
                  } else {
                    update({ [key]: value });
                  }
                }}
              />
            )}
          </Field>
        ))}
        <Field label="Priority (1–10)" path={`${base}.priority`}>
          {({ id, invalid }) => (
            <input
              id={id}
              type="number"
              min={1}
              max={10}
              step={1}
              aria-invalid={invalid || undefined}
              value={spec.priority === undefined ? "" : String(spec.priority)}
              onChange={(event) => {
                const text = event.target.value.trim();
                if (text === "") {
                  remove("priority");
                } else {
                  update({ priority: Number(text) });
                }
              }}
            />
          )}
        </Field>
        <Field label="Fallback profile" path={`${base}.fallback`}>
          {({ id, invalid }) => (
            <Select
              id={id}
              invalid={invalid}
              value={fallback}
              options={fallbackOptions}
              onChange={(value) => {
                if (value === "") {
                  remove("fallback");
                } else {
                  update({ fallback: value });
                }
              }}
            />
          )}
        </Field>
        <div className="field field-check" data-path={`${base}.parallel_ok`}>
          <Checkbox
            label="Parallel OK"
            checked={spec.parallel_ok === true}
            onChange={(checked) => {
              if (checked) {
                update({ parallel_ok: true });
              } else {
                remove("parallel_ok");
              }
            }}
          />
          <FieldErrors path={`${base}.parallel_ok`} />
        </div>
        <FormSection title="Tags & hints" />
        {lineField("tags", "Tags", 2, LINE_HINTS.tags)}
        {lineField("strengths", "Strengths", 2, LINE_HINTS.tags)}
        {lineField("avoid_for", "Avoid for", 2, LINE_HINTS.tags)}
        {lineField("example_tasks", "Example tasks", 2, LINE_HINTS.tags)}
        <FormSection title="Spawn" />
        {lineField("flags", "Flags", 3, LINE_HINTS.flags)}
        <Field label="Environment" path={`${base}.env`} hint={LINE_HINTS.env}>
          {({ id, invalid }) => (
            <textarea
              id={id}
              rows={3}
              spellCheck={false}
              aria-invalid={invalid || undefined}
              value={lines.env}
              onChange={(event) => {
                setLine("env", event.target.value);
              }}
            />
          )}
        </Field>
        {lineField("auth", "Auth keys", 2, LINE_HINTS.auth)}
        <div className="actions">
          <Button variant="primary" type="submit" disabled={editor.saving}>
            Save
          </Button>{" "}
          <Button onClick={editor.cancel}>Cancel</Button>
          {isNew ? null : (
            <>
              {" "}
              <SanityTestButton label="Sanity test" profiles={[target]} />{" "}
              <Button variant="danger" disabled={doc.settings.default_profile === target} onClick={onDelete}>
                Delete
              </Button>
              {doc.settings.default_profile === target ? <div className="hint">{DEFAULT_DELETE_HINT}</div> : null}
            </>
          )}
        </div>
      </form>
    </IssuesProvider>
  );
}
