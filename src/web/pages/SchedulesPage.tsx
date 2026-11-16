import { useEffect, useRef, useState } from "react";
import type { Schedule, ScheduleKind, ScheduleRun } from "../../shared/types/schedule";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { invalidateSchedules, useDocument, useSchedules } from "../api/queries";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { useConfirm } from "../components/ConfirmDialog";
import { Countdown } from "../components/Countdown";
import { EmptyState } from "../components/EmptyState";
import "./pages.css";
import { PageHead } from "../components/PageHead";
import { PanelBox } from "../components/Panel";
import { RunStrip } from "../components/RunStrip";
import { Labelled, Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { Toggle } from "../components/Toggle";
import { PickerSelect } from "../chats/PickerSelect";
import { useChatOptions } from "../chats/queries";
import { ChatLink } from "../chats/ChatLink";
import { automationApi } from "../api/automation";
import { asProfilesDocument } from "../lib/documents";
import { describeCron } from "../lib/cron-text";
import { fmtDur, rel, until } from "../lib/format";

const fmtMs = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
import { useSessionState } from "../lib/session-state";
import {
  CRON_PRESETS,
  CUSTOM_CRON,
  draftErrors,
  draftOf,
  emptyScheduleDraft,
  FILTERS,
  healthOf,
  matchesFilter,
  modelText,
  scheduleEditPayload,
  scheduleModelOptions,
  schedulePayload,
  soonestNext,
  visibleSchedules,
} from "../lib/schedule-logic";
import type { DraftErrors, ScheduleDraft, ScheduleFilter } from "../lib/schedule-logic";

function StatusChip({ status }: { status: string | null }) {
  if (status === null) {
    return <Chip status="waiting">never run</Chip>;
  }
  return <Chip status={status === "ok" ? "done" : status}>{status}</Chip>;
}

function RunRow({
  schedule,
  run,
  index,
  log,
  onLoadLog,
}: {
  schedule: Schedule;
  run: ScheduleRun;
  index: number;
  log: string | undefined;
  onLoadLog: (schedule: Schedule, index: number, run: ScheduleRun) => void;
}) {
  return (
    <div className="sched-run-wrap">
      <div className="sched-run">
        <StatusChip status={run.status} />
        <span className="sched-run-time">{rel(run.started_at)}</span>
        {run.kind === "chat" ? <span className="muted">{run.error ?? run.note ?? (run.duration_ms == null ? "" : fmtMs(run.duration_ms))}</span> : null}
        <span className="muted">{run.status === "running" ? "running…" : fmtDur(run.started_at, run.ended_at)}</span>
        <span className="muted mono">{run.exit === null ? "" : `exit ${run.exit}`}</span>
        {run.kind === "prompt" ? (
          <span className={run.model ? "sched-run-model mono" : "sched-run-model mono muted"} title="Model this run used">
            {modelText(run)}
          </span>
        ) : null}
        {run.kind === "chat" ? null : (
          <Button
            className="sched-view"
            onClick={() => {
              onLoadLog(schedule, index, run);
            }}
          >
            {log === undefined ? "Output" : "Reload output"}
          </Button>
        )}
      </div>
      {log === undefined ? null : <pre className="sched-log">{log.length > 0 ? log : "(no output)"}</pre>}
    </div>
  );
}

function NextCell({ schedule }: { schedule: Schedule }) {
  if (!schedule.enabled || schedule.next_at === null) {
    return (
      <div className="sched-next">
        <span className="sched-next-label">next run</span>
        <span className="sched-next-value muted">{schedule.enabled ? "none" : "paused"}</span>
      </div>
    );
  }
  return (
    <div className="sched-next">
      <span className="sched-next-label">next run in</span>
      <span className="sched-next-value">
        <Countdown at={schedule.next_at} />
      </span>
    </div>
  );
}

function ScheduleRow({
  schedule,
  open,
  busy,
  logs,
  editor,
  onToggleOpen,
  onEdit,
  onAct,
  onRemove,
  onLoadLog,
}: {
  schedule: Schedule;
  open: boolean;
  busy: boolean;
  logs: ReadonlyMap<string, string>;
  /** The edit form, when this row is being edited; it takes the row's place. */
  editor: React.ReactNode;
  onToggleOpen: () => void;
  onEdit: () => void;
  onAct: (action: "run" | "enable" | "disable") => void;
  onRemove: () => void;
  onLoadLog: (schedule: Schedule, index: number, run: ScheduleRun) => void;
}) {
  const health = healthOf(schedule);
  const what =
    schedule.kind === "prompt"
      ? `${schedule.profile ?? ""} · ${schedule.prompt ?? ""}`
      : `${schedule.workdir === null ? "" : `${schedule.workdir} · `}${schedule.command ?? ""}`;
  if (editor !== null && editor !== undefined) {
    return <article className="sched-row is-editing">{editor}</article>;
  }
  return (
    <article className={`sched-row is-${health}`}>
      <div className="sched-title">
        <div className="sched-head">
          <h3 className="sched-name">{schedule.name}</h3>
          <span className="sched-kind">{schedule.target === undefined ? schedule.kind : "chat"}</span>
          {health === "paused" ? <Chip status="default">paused</Chip> : <StatusChip status={schedule.last_status} />}
        </div>
        <div className="sched-sub">
          <span className="mono">{schedule.cron}</span>
          <span className="muted sched-meaning">{cronMeaning(schedule.cron)}{schedule.timezone === undefined ? "" : ` (${schedule.timezone})`}</span>
          {schedule.target === undefined ? null : <span className="sched-chat" data-testid="sched-chat"><span className="muted">chat</span> <ChatLink id={schedule.target.chat_id} /> <span className="muted">· {schedule.target.mode === "fresh" ? "fresh session" : "continues the chat"}</span></span>}
          {schedule.kind === "prompt" ? (
            <span className={schedule.model ? "sched-model mono" : "sched-model mono muted"} title="Model the prompt runs on">
              {`model: ${modelText(schedule)}`}
            </span>
          ) : null}
        </div>
        <div className="sched-what mono" title={what}>
          {what}
        </div>
      </div>
      <div className="sched-history">
        <RunStrip runs={schedule.runs} />
        {schedule.last_run_at === null ? null : <span className="sched-last">{`last run ${rel(schedule.last_run_at)}`}</span>}
      </div>
      <NextCell schedule={schedule} />
      <div className="sched-actions">
        <Toggle
          label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
          on={schedule.enabled}
          disabled={busy}
          onChange={(next) => {
            onAct(next ? "enable" : "disable");
          }}
        />
        <Button
          disabled={busy}
          onClick={() => {
            onAct("run");
          }}
        >
          Run now
        </Button>
        {schedule.target === undefined ? (
          <Button disabled={busy} aria-label={`Edit ${schedule.name}`} onClick={onEdit}>
            Edit
          </Button>
        ) : (
          <a className="btn" href={`#/chats/${encodeURIComponent(schedule.target.chat_id)}`}>Edit in chat</a>
        )}
        <Button aria-expanded={open} onClick={onToggleOpen}>
          {open ? "Hide runs" : `Runs (${schedule.runs.length})`}
        </Button>
      </div>
      {open ? (
        <div className="sched-detail">
          {schedule.prompt !== null || schedule.command !== null ? <pre className="sched-full">{schedule.prompt ?? schedule.command ?? ""}</pre> : null}
          {schedule.runs.length === 0 ? <p className="sub">No runs yet. Use Run now to try it.</p> : null}
          {schedule.runs.map((run, index) => (
            <RunRow key={`${run.started_at}-${index}`} schedule={schedule} run={run} index={index} log={logs.get(`${schedule.id}:${run.started_at}`)} onLoadLog={onLoadLog} />
          ))}
          <div className="sched-detail-foot">
            <Button variant="danger" onClick={onRemove}>
              Delete schedule
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function cronMeaning(cron: string): string {
  const meaning = describeCron(cron);
  return meaning === null || !meaning.ok ? "Invalid cron" : meaning.text;
}

function CronField({ cron, error, onChange }: { cron: string; error?: string | undefined; onChange: (cron: string) => void }) {
  const known = CRON_PRESETS.some((preset) => preset.cron === cron);
  const meaning = describeCron(cron);
  const meaningBad = meaning !== null && !meaning.ok;
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const value = cron.trim();
    let live = true;
    const timer = setTimeout(() => {
      void api.previewSchedule(value).then((result) => {
        if (!live) {
          return;
        }
        if (result.kind === "ok") {
          setPreview({ ok: true, text: `Next run: ${result.body.next}` });
        } else if (result.kind === "error") {
          setPreview({ ok: false, text: result.body?.error ?? "not a valid cron expression" });
        }
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cron]);
  return (
    <Labelled label="When">
      <div className="sched-when-wrap">
        <div className="sched-when">
          <Select
            aria-label="Preset"
            value={known ? cron : CUSTOM_CRON}
            options={[...CRON_PRESETS.map((preset) => ({ value: preset.cron, label: preset.label })), { value: CUSTOM_CRON, label: "Custom…" }]}
            onChange={(value) => {
              if (value !== CUSTOM_CRON) {
                onChange(value);
              }
            }}
          />
          <input
            type="text"
            className="mono"
            aria-label="Cron expression"
            aria-invalid={error !== undefined || meaningBad || preview?.ok === false || undefined}
            placeholder="m h dom mon dow"
            value={cron}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </div>
        <div className={error !== undefined || meaningBad ? "sched-preview is-bad" : preview === null ? "sched-preview" : `sched-preview ${preview.ok ? "is-ok" : "is-bad"}`} role="status" aria-live="polite">
          {error ??
            (meaningBad ? "Invalid cron" : (
              <>
                {meaning?.ok ? <span className="sched-meaning">{meaning.text}</span> : null}
                {meaning?.ok && preview !== null ? " " : null}
                {preview?.text === undefined ? null : <span>{preview.text}</span>}
              </>
            ))}
        </div>
      </div>
    </Labelled>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <div className="sched-field-error">{message}</div>;
}

function TextInput({
  label,
  value,
  placeholder,
  mono = false,
  error,
  inputRef,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  mono?: boolean;
  error?: string | undefined;
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}) {
  return (
    <Labelled label={label}>
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        aria-invalid={error !== undefined || undefined}
        className={mono ? "mono" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <FieldError message={error} />
    </Labelled>
  );
}

function ScheduleForm({
  profileNames,
  defaultProfile,
  editing,
  onSaved,
  onCancel,
}: {
  profileNames: readonly string[];
  defaultProfile: string;
  /** The schedule being edited; absent for a new one. */
  editing?: Schedule | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  // A new schedule's draft survives a reload; an edit starts from the schedule every time.
  const [newDraft, setNewDraft] = useSessionState<ScheduleDraft>("schedule-draft", emptyScheduleDraft());
  const [editDraft, setEditDraft] = useState<ScheduleDraft>(() => (editing === undefined ? emptyScheduleDraft() : draftOf(editing)));
  const draft = editing === undefined ? newDraft : editDraft;
  const setDraft = editing === undefined ? setNewDraft : setEditDraft;
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // Focus the name once per opened edit, not on every list refresh: a run that lands while the form is
  // open gives `editing` a new object, and re-focusing would pull the cursor out of the field being typed in.
  const editingId = editing?.id;
  useEffect(() => {
    if (editingId !== undefined) {
      nameRef.current?.focus();
    }
  }, [editingId]);
  const set = (patch: Partial<ScheduleDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setFieldErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) {
        delete next[key as keyof DraftErrors];
      }
      return next;
    });
  };
  const profile = draft.profile === "" ? defaultProfile || profileNames[0] || "" : draft.profile;
  const chatOptions = useChatOptions("runs");
  const model = draft.model ?? "";
  const modelOptions = scheduleModelOptions(chatOptions.data, profile, model);
  const modelNote = chatOptions.isLoading ? "loading models…" : modelOptions.length === 1 ? "no other model for this profile" : null;
  const submit = async (): Promise<void> => {
    const current = { ...draft, profile, model };
    const problems = draftErrors(current);
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    const result = editing === undefined ? await api.createSchedule(schedulePayload(current)) : await api.editSchedule(editing.id, scheduleEditPayload(current));
    setSaving(false);
    if (result.kind === "ok") {
      toast("ok", editing === undefined ? `Created ${current.name.trim()}` : `Saved ${current.name.trim()}`);
      if (editing === undefined) {
        setNewDraft(emptyScheduleDraft());
      }
      onSaved();
      return;
    }
    setError(result.kind === "error" ? (result.body?.error ?? `failed (${result.status})`) : describeFailure(result, "failed"));
  };
  const verb = editing === undefined ? (saving ? "Creating…" : "Create schedule") : saving ? "Saving…" : "Save changes";
  return (
    <PanelBox className={editing === undefined ? "sched-form" : "sched-form is-edit"}>
      <form
        className="sched-form-body"
        aria-label={editing === undefined ? "New schedule" : `Edit ${editing.name}`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        {editing === undefined ? null : <h3 className="sched-form-title">{`Edit ${editing.name}`}</h3>}
        <div className="sched-form-row">
          <TextInput label="Name" value={draft.name} placeholder="Morning repo summary" error={fieldErrors.name} inputRef={nameRef} onChange={(name) => { set({ name }); }} />
          <Labelled label="Runs a">
            <Segmented
              label="What to run"
              value={draft.kind}
              options={[
                { value: "prompt", label: "Prompt" },
                { value: "command", label: "Shell command" },
              ]}
              onChange={(next) => {
                set({ kind: next as ScheduleKind });
              }}
            />
          </Labelled>
        </div>
        <CronField cron={draft.cron} error={fieldErrors.cron} onChange={(cron) => { set({ cron }); }} />
        {draft.kind === "prompt" ? (
          <>
            <div className="sched-form-row sched-profile-row">
              <Labelled label="Profile">
                <Select aria-label="Profile" invalid={fieldErrors.profile !== undefined} value={profile} options={profileNames.map((name) => ({ value: name, label: name }))} onChange={(value) => { set({ profile: value, model: "" }); }} />
                <FieldError message={fieldErrors.profile} />
              </Labelled>
              <PickerSelect
                testId="schedule-model"
                label="Model"
                value={model}
                options={modelOptions}
                disabled={modelOptions.length === 1}
                note={modelNote}
                onChange={(value) => { set({ model: value }); }}
              />
            </div>
            <Labelled label="Prompt">
              <textarea rows={4} aria-label="Prompt" aria-invalid={fieldErrors.prompt !== undefined || undefined} placeholder="What should the agent do each time?" value={draft.prompt} onChange={(event) => { set({ prompt: event.target.value }); }} />
              <FieldError message={fieldErrors.prompt} />
            </Labelled>
          </>
        ) : (
          <>
            <Labelled label="Command">
              <textarea rows={3} aria-label="Command" aria-invalid={fieldErrors.command !== undefined || undefined} placeholder="git -C ~/repo pull && ./scripts/report.sh" value={draft.command} onChange={(event) => { set({ command: event.target.value }); }} />
              <FieldError message={fieldErrors.command} />
            </Labelled>
            <div className="sched-form-row">
              <TextInput label="Working directory (optional)" value={draft.workdir} placeholder="/Users/you/repo" mono onChange={(workdir) => { set({ workdir }); }} />
              <TextInput label="Time limit (optional)" value={draft.timeout} placeholder="30m, default 1h" mono error={fieldErrors.timeout} onChange={(timeout) => { set({ timeout }); }} />
            </div>
          </>
        )}
        {error === null ? null : (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
        <div className="sched-form-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {verb}
          </Button>
        </div>
      </form>
    </PanelBox>
  );
}

function Summary({ list }: { list: readonly Schedule[] }) {
  const active = list.filter((s) => s.enabled);
  const running = list.filter((s) => s.enabled && s.last_status === "running").length;
  const failing = list.filter((s) => healthOf(s) === "failing").length;
  const soonest = soonestNext(list);
  return (
    <dl className="ledger-summary" aria-label="Schedule summary">
      <div>
        <dt>Active</dt>
        <dd className="mono">{`${active.length}/${list.length}`}</dd>
      </div>
      <div>
        <dt>Next run</dt>
        <dd className="mono">{soonest === null ? "—" : <Countdown at={soonest} />}</dd>
      </div>
      <div>
        <dt>Running</dt>
        <dd className={running > 0 ? "mono is-running" : "mono"}>{running > 0 ? `${running} running` : "idle"}</dd>
      </div>
      <div>
        <dt>Attention</dt>
        <dd className={failing > 0 ? "mono is-error" : "mono is-done"}>{failing > 0 ? `${failing} failing` : "all clear"}</dd>
      </div>
    </dl>
  );
}

/** The `#/schedules` page: cron schedules that run a prompt or a shell command. */
export function SchedulesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const query = useSchedules();
  const profiles = useDocument("profiles", false);
  const [formOpen, setFormOpen] = useSessionState("schedule-form-open", false);
  const [filter, setFilter] = useSessionState<ScheduleFilter>("schedule-filter", "all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [logs, setLogs] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const profilesDoc = asProfilesDocument(profiles.data?.document);
  const profileNames = profilesDoc === null ? [] : Object.keys(profilesDoc.profiles);
  const defaultProfile = profilesDoc?.settings.default_profile ?? "";
  const list = query.data?.schedules ?? null;

  const setBusyFor = (id: string, on: boolean): void => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const act = async (schedule: Schedule, action: "run" | "enable" | "disable"): Promise<void> => {
    setBusyFor(schedule.id, true);
    const result = schedule.target !== undefined && action === "run" ? await automationApi.scheduleAction(schedule.target.chat_id, schedule.id, "run-now") : await api.scheduleAction(schedule.id, action);
    setBusyFor(schedule.id, false);
    if (result.kind !== "ok") {
      toast("error", result.kind === "error" ? (result.body?.error ?? `failed (${result.status})`) : describeFailure(result, "failed"));
      return;
    }
    toast("ok", action === "run" ? `Started ${schedule.name}` : `${schedule.name} ${action}d`);
    void invalidateSchedules();
  };
  const remove = async (schedule: Schedule): Promise<void> => {
    const confirmed = await confirm({
      title: `Delete schedule ${schedule.name}?`,
      body: "It stops running and its run history is removed. Runs already in progress keep going.",
      confirmLabel: "Delete schedule",
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    const result = await api.scheduleAction(schedule.id, "remove");
    if (result.kind !== "ok") {
      toast("error", result.kind === "error" ? (result.body?.error ?? `failed (${result.status})`) : describeFailure(result, "failed"));
      return;
    }
    setExpanded((current) => new Set([...current].filter((id) => id !== schedule.id)));
    void invalidateSchedules();
  };
  const loadLog = async (schedule: Schedule, index: number, run: ScheduleRun): Promise<void> => {
    const key = `${schedule.id}:${run.started_at}`;
    setLogs((current) => new Map(current).set(key, "Loading…"));
    const result = await api.getScheduleRunLog(schedule.id, index);
    setLogs((current) => new Map(current).set(key, result.kind === "ok" ? result.body.text : "Could not load the output."));
  };

  const sub = list === null ? "Loading…" : "Each one runs a prompt or a shell command on a cron timetable. The dashboard server checks them every 30 s.";
  const add = (
    <Button
      variant="primary"
      onClick={() => {
        setFormOpen(true);
      }}
    >
      New schedule
    </Button>
  );
  const shown = list === null ? [] : visibleSchedules(list, filter);
  return (
    <>
      <PageHead title="Schedules" subtitle={sub} toolbar={formOpen ? undefined : add} />
      {formOpen ? (
        <ScheduleForm
          profileNames={profileNames}
          defaultProfile={defaultProfile}
          onSaved={() => {
            setFormOpen(false);
            void invalidateSchedules();
          }}
          onCancel={() => {
            setFormOpen(false);
          }}
        />
      ) : null}
      {list === null ? (
        query.error === null ? <Skeleton rows={3} /> : <div className="notice">{query.error.message}</div>
      ) : list.length === 0 ? (
        formOpen ? null : (
          <EmptyState title="No schedules yet">
            Press New schedule to run a prompt or a shell command on a timetable. It keeps running while the dashboard server is up.
          </EmptyState>
        )
      ) : (
        <>
          <Summary list={list} />
          <Labelled label="Show">
            <Segmented
              label="Filter schedules"
              value={filter}
              options={FILTERS.map((f) => ({ value: f, label: `${f[0]?.toUpperCase()}${f.slice(1)} ${list.filter((s) => matchesFilter(s, f)).length}` }))}
              onChange={(next) => {
                setFilter(next as ScheduleFilter);
              }}
            />
          </Labelled>
          {shown.length === 0 ? (
            <EmptyState title={`No ${filter} schedules`}>Pick All to see every schedule.</EmptyState>
          ) : (
            <PanelBox className="sched-ledger">
              {shown.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  open={expanded.has(schedule.id)}
                  busy={busy.has(schedule.id)}
                  logs={logs}
                  editor={
                    editingId === schedule.id ? (
                      <ScheduleForm
                        profileNames={profileNames}
                        defaultProfile={defaultProfile}
                        editing={schedule}
                        onSaved={() => {
                          setEditingId(null);
                          void invalidateSchedules();
                        }}
                        onCancel={() => {
                          setEditingId(null);
                        }}
                      />
                    ) : null
                  }
                  onEdit={() => {
                    setEditingId(schedule.id);
                  }}
                  onToggleOpen={() => {
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (!next.delete(schedule.id)) {
                        next.add(schedule.id);
                      }
                      return next;
                    });
                  }}
                  onAct={(action) => void act(schedule, action)}
                  onRemove={() => void remove(schedule)}
                  onLoadLog={(s, index, run) => void loadLog(s, index, run)}
                />
              ))}
            </PanelBox>
          )}
        </>
      )}
    </>
  );
}
