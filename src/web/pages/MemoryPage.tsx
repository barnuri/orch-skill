import "./pages-b.css";
import { useState } from "react";
import type { FormEvent } from "react";
import type { MemoryEntry } from "../../shared/types/memory-entry";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { useConfirm } from "../components/ConfirmDialog";
import { PageHead } from "../components/PageHead";
import { Panel } from "../components/Panel";
import { Select } from "../components/Select";
import { DocNotices } from "../forms/DocNotices";
import { Field, IssueList, IssuesProvider, useMatchedIssues } from "../forms/Field";
import { useDocEditor, useEscapeToClose } from "../forms/use-doc-editor";
import type { DocEditor } from "../forms/use-doc-editor";
import { useDocument } from "../api/queries";
import { asMemoryDocument, asProfilesDocument } from "../lib/documents";
import { fmtTime, nowIso, truncate } from "../lib/format";

const NOTE_MAX = 72;
const CORRUPT_HINT = "memory.json could not be parsed — fix it in an editor and this page picks it up.";
const PROFILES_LIST_ID = "memory-profiles";

/** Pinned "Add entry" prefill: `default_profile` keeps the common case off a guaranteed 400 (the server rejects an empty profile). */
export function newMemoryEntry(outcomes: readonly string[], defaultProfile: string, now: string = nowIso()): MemoryEntry {
  return { ts: now, task_kind: "", profile: defaultProfile, harness: "", model: "", outcome: outcomes[0] ?? "", note: "" };
}

/** Newest first (the file grows at the end) while every row keeps its real array index. */
export function newestFirst(entries: readonly MemoryEntry[]): { index: number; entry: MemoryEntry }[] {
  return entries.map((entry, index) => ({ index, entry })).reverse();
}

function MemoryForm({
  editor,
  entries,
  target,
  profileNames,
  outcomes,
  defaultProfile,
}: {
  editor: DocEditor;
  entries: readonly MemoryEntry[];
  target: number | "new";
  profileNames: readonly string[];
  outcomes: readonly string[];
  defaultProfile: string;
}) {
  const confirm = useConfirm();
  const [entry, setEntry] = useState<MemoryEntry>(() => (target === "new" ? newMemoryEntry(outcomes, defaultProfile) : { ...(entries[target] as MemoryEntry) }));
  const index = target === "new" ? entries.length : target;
  const pathOf = (field: string): string => `memory[${index}].${field}`;
  const paths = ["ts", "profile", "outcome", "task_kind", "harness", "model", "note"].map(pathOf);
  const matched = useMatchedIssues(paths, editor.fieldIssues);
  const set = (patch: Partial<MemoryEntry>): void => {
    setEntry((current) => ({ ...current, ...patch }));
    editor.markDirty();
  };
  // A value the server does not accept (or a still-empty one) is offered too, so opening the form
  // never silently rewrites what is on disk.
  const outcomeValues = outcomes.includes(entry.outcome) ? outcomes : [entry.outcome, ...outcomes];

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next = target === "new" ? [...entries, entry] : entries.map((existing, at) => (at === target ? entry : existing));
    void editor.save(next);
  };
  const remove = (): void => {
    void confirm({
      title: `Delete the ${entry.profile || "(no profile)"} entry from ${entry.ts}?`,
      body: "Removes it from memory.json; the run it describes is untouched.",
      confirmLabel: "Delete",
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        void editor.save(entries.filter((_, at) => at !== target));
      }
    });
  };
  return (
    <IssuesProvider value={matched}>
      <form className="form" onSubmit={submit}>
        <h2>{target === "new" ? "New entry" : "Edit entry"}</h2>
        <IssueList issues={matched.unmatched} />
        <Field label="Recorded" path={pathOf("ts")}>
          {({ id }) => <input id={id} className="mono" type="text" readOnly aria-readonly="true" value={entry.ts} />}
        </Field>
        <Field label="Profile" path={pathOf("profile")}>
          {({ id, invalid }) => (
            <input
              id={id}
              type="text"
              list={PROFILES_LIST_ID}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              value={entry.profile}
              onChange={(event) => {
                set({ profile: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label="Outcome" path={pathOf("outcome")}>
          {({ id, invalid }) => (
            <Select
              id={id}
              invalid={invalid}
              value={entry.outcome}
              options={outcomeValues.map((value) => ({ value, label: value }))}
              onChange={(value) => {
                set({ outcome: value });
              }}
            />
          )}
        </Field>
        {(
          [
            ["Task kind", "task_kind"],
            ["Harness", "harness"],
            ["Model", "model"],
          ] as const
        ).map(([label, key]) => (
          <Field key={key} label={label} path={pathOf(key)}>
            {({ id, invalid }) => (
              <input
                id={id}
                type="text"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                value={entry[key] ?? ""}
                onChange={(event) => {
                  set({ [key]: event.target.value });
                }}
              />
            )}
          </Field>
        ))}
        <Field label="Note" path={pathOf("note")}>
          {({ id, invalid }) => (
            <textarea
              id={id}
              rows={4}
              aria-invalid={invalid || undefined}
              value={entry.note ?? ""}
              onChange={(event) => {
                set({ note: event.target.value });
              }}
            />
          )}
        </Field>
        <datalist id={PROFILES_LIST_ID}>
          {profileNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <div className="actions">
          <Button variant="primary" type="submit" disabled={editor.saving}>
            Save
          </Button>{" "}
          <Button onClick={editor.cancel}>Cancel</Button>
          {typeof target === "number" ? (
            <>
              {" "}
              <Button variant="danger" disabled={editor.saving} onClick={remove}>
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </form>
    </IssuesProvider>
  );
}

/** The `#/memory` page: entries newest first, a form for one entry on the right. */
export function MemoryPage() {
  const memory = useDocument("memory");
  const profiles = useDocument("profiles", false);
  const editor = useDocEditor("memory", memory.data);
  useEscapeToClose(editor);
  const profilesDoc = asProfilesDocument(profiles.data?.document);
  const profileNames = profilesDoc === null ? [] : Object.keys(profilesDoc.profiles);
  const defaultProfile = profilesDoc?.settings.default_profile ?? "";
  const base = editor.base;
  const entries = base === null ? null : asMemoryDocument(base.document);
  const count = entries?.length ?? 0;
  const sub = base === null ? "Loading…" : entries === null ? "memory.json could not be read." : `${count} ${count === 1 ? "entry" : "entries"} · newest first`;

  if (base === null || entries === null) {
    return (
      <>
        <PageHead title="Memory" subtitle={sub} />
        <DocNotices kind="memory" editor={editor} />
        {base === null && memory.error !== null ? <div className="notice" role="alert">{`Could not load memory: ${memory.error.message}`}</div> : null}
        {base === null && memory.error === null ? (
          <div className="memory-skeleton" aria-busy="true">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        ) : null}
        {base !== null ? <div className="empty">{CORRUPT_HINT}</div> : null}
      </>
    );
  }
  const target = editor.target;
  return (
    <>
      <PageHead title="Memory" subtitle={sub} />
      <DocNotices kind="memory" editor={editor} />
      <div className="layout">
        {entries.length === 0 ? (
          <div className="empty">
            No entries yet. Record one here, or with <code>dispatch.ts memory add --profile &lt;name&gt; --outcome success</code>.
          </div>
        ) : (
          <div className="runs" role="list">
            {newestFirst(entries).map(({ index, entry }) => (
              <button
                key={index}
                className={target === index ? "doc-row memory-row selected" : "doc-row memory-row"}
                type="button"
                onClick={() => {
                  editor.begin(index);
                }}
              >
                <div className="title">{fmtTime(entry.ts)}</div>
                <div className="mono">{entry.profile}</div>
                <Chip status={entry.outcome} />
                <div className="muted">{entry.task_kind ?? ""}</div>
                <div className="muted">{truncate(entry.note ?? "", NOTE_MAX)}</div>
              </button>
            ))}
          </div>
        )}
        {target === "new" || typeof target === "number" ? (
          <Panel>
            <MemoryForm
              key={`${editor.session}`}
              editor={editor}
              entries={entries}
              target={target}
              profileNames={profileNames}
              outcomes={base.enums}
              defaultProfile={defaultProfile}
            />
          </Panel>
        ) : (
          <Panel title="Memory">
            <p className="hint">Pick an entry to edit it, or record what a run taught you.</p>
            <Button
              variant="primary"
              onClick={() => {
                editor.begin("new");
              }}
            >
              Add entry
            </Button>
          </Panel>
        )}
      </div>
    </>
  );
}
