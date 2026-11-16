import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { type SlashCommand, guessMonitor, parseSlash, SCHEDULE_PRESETS, LIMITS } from "../../shared/chat-automation";
import { machineZone } from "../../shared/cron-next";
import type { ChatLoop, ChatMonitor, LogEntry } from "../../shared/types/chat-automation";
import type { Schedule } from "../../shared/types/schedule";
import { automationApi } from "../api/automation";
import { describeFailure } from "../api/result";
import type { ApiResult } from "../api/result";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Toggle } from "../components/Toggle";
import { everyLabel, rel, until } from "../lib/format";
import { AutomationContext } from "./automation-context";
import type { AutomationApi } from "./automation-context";
import {
  EMPTY_TEXT, MONITOR_TYPES, TABS, activeCounts, draftOfSchedule, emptyLoopDraft, emptyMonitorDraft, emptyScheduleDraft, itemTone, lastResult, loopBody, loopProgress, loopSummary,
  monitorBody, monitorExpiry, monitorSummary, nameFrom, previewOf, scheduleBody, scheduleSummary, scheduleTone,
} from "./automation-logic";
import type { LoopDraft, MonitorDraft, ScheduleDraft, Tab, Tone } from "./automation-logic";
import "./automation.css";

const POLL_CLOSED_MS = 10_000;
const POLL_OPEN_MS = 3_000;

const keys = {
  schedules: (id: string) => ["automation", id, "schedules"] as const,
  loops: (id: string) => ["automation", id, "loops"] as const,
  monitors: (id: string) => ["automation", id, "monitors"] as const,
};

function unwrap<T>(res: ApiResult<T>): T {
  if (res.kind === "ok") return res.body;
  throw new Error(describeFailure(res as Exclude<ApiResult<T>, { kind: "ok" }>, "request failed"));
}

function useLists(chatId: string, open: boolean) {
  const refetchInterval = open ? POLL_OPEN_MS : POLL_CLOSED_MS;
  const schedules = useQuery<Schedule[]>({ queryKey: keys.schedules(chatId), queryFn: async () => unwrap(await automationApi.schedules(chatId)).items, refetchInterval });
  const loops = useQuery<ChatLoop[]>({ queryKey: keys.loops(chatId), queryFn: async () => unwrap(await automationApi.loops(chatId)).items, refetchInterval });
  const monitors = useQuery<ChatMonitor[]>({ queryKey: keys.monitors(chatId), queryFn: async () => unwrap(await automationApi.monitors(chatId)).items, refetchInterval });
  return { schedules: schedules.data ?? [], loops: loops.data ?? [], monitors: monitors.data ?? [] };
}

type Create = { kind: Tab; prefill: string; editing?: Schedule } | null;

/** Mounts the chat's schedule, loop and monitor controls: the header button reads `counts`, the composer and messages call `openCreate`. */
export function AutomationHost({ chatId, children }: { chatId: string; children: ReactNode }) {
  const toast = useToast();
  const client = useQueryClient();
  const [list, setList] = useState<Tab | null>(null);
  const [create, setCreate] = useState<Create>(null);
  const lists = useLists(chatId, list !== null);
  const counts = useMemo(() => activeCounts(lists.schedules, lists.loops, lists.monitors), [lists.schedules, lists.loops, lists.monitors]);
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ["automation", chatId] });
  };

  const runSlash = async (cmd: SlashCommand): Promise<string | null> => {
    if (cmd.cmd === "error") return cmd.message;
    if (cmd.cmd === "schedules" || cmd.cmd === "loops" || cmd.cmd === "monitors") {
      setList(cmd.cmd);
      return null;
    }
    if (cmd.cmd === "schedule") {
      const res = await automationApi.createSchedule(chatId, { name: nameFrom(cmd.prompt), prompt: cmd.prompt, cron: cmd.cron, timezone: machineZone(), mode: "message" });
      if (res.kind !== "ok") return describeFailure(res, "could not save the schedule");
      toast("ok", `Scheduled: ${nameFrom(cmd.prompt)}`);
    } else if (cmd.cmd === "loop") {
      const secs = Number(/^\d+/.exec(cmd.every)?.[0] ?? 0) * ({ s: 1, m: 60, h: 3600, d: 86400 }[cmd.every.slice(-1) as "s" | "m" | "h" | "d"] ?? 1);
      const res = await automationApi.createLoop(chatId, { label: nameFrom(cmd.prompt), prompt: cmd.prompt, every: secs, max: 20, mode: "message" });
      if (res.kind !== "ok") return describeFailure(res, "could not start the loop");
      toast("ok", `Loop started: every ${cmd.every}, up to 20 times`);
    } else if ("what" in cmd) {
      const spec = guessMonitor(cmd.what);
      const res = await automationApi.createMonitor(chatId, { name: cmd.what.slice(0, 40), spec, every: spec.type === "url" ? LIMITS.minUrlSecs : 30, then: { mode: "tell" } });
      if (res.kind !== "ok") return describeFailure(res, "could not start the monitor");
      toast("ok", "Monitor started");
    }
    refresh();
    return null;
  };

  const api: AutomationApi = {
    chatId,
    counts,
    openList: (tab = "schedules") => { setList(tab); },
    openCreate: (kind, prefill = "") => { setCreate({ kind, prefill }); },
    slash: async (text) => {
      const cmd = parseSlash(text);
      return cmd === null ? undefined : runSlash(cmd);
    },
  };

  return (
    <AutomationContext value={api}>
      {children}
      {list !== null ? (
        <ListSheet
          chatId={chatId}
          tab={list}
          lists={lists}
          onTab={setList}
          onClose={() => { setList(null); }}
          onNew={(kind) => { setCreate({ kind, prefill: "" }); }}
          onEdit={(s) => { setCreate({ kind: "schedules", prefill: "", editing: s }); }}
          refresh={refresh}
        />
      ) : null}
      {create !== null ? (
        <CreateSheet
          chatId={chatId}
          create={create}
          onClose={() => { setCreate(null); }}
          onDone={(kind) => {
            setCreate(null);
            setList(kind);
            refresh();
          }}
        />
      ) : null}
    </AutomationContext>
  );
}

// ---------------------------------------------------------------- header button

/** The header button: opens the list sheet; the badge counts what is active; a pulse shows a loop or monitor is running. */
export function AutomationButton({ api }: { api: AutomationApi }) {
  const { total, live } = api.counts;
  return (
    <button type="button" className="btn chat-head-auto" aria-haspopup="dialog" onClick={() => { api.openList(); }} data-testid="automation-btn">
      {live ? <span className="auto-live" role="img" aria-label="A loop or monitor is active" /> : null}
      Schedules
      {total > 0 ? <span className="auto-badge" data-testid="automation-count" aria-label={`${total} active`}>{total}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------- list sheet

interface Lists { schedules: Schedule[]; loops: ChatLoop[]; monitors: ChatMonitor[] }

function useDismiss(onClose: () => void): void {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); };
  }, [onClose]);
}

function ListSheet({ chatId, tab, lists, onTab, onClose, onNew, onEdit, refresh }: {
  chatId: string; tab: Tab; lists: Lists; onTab: (t: Tab) => void; onClose: () => void; onNew: (k: Tab) => void; onEdit: (s: Schedule) => void; refresh: () => void;
}) {
  const title = useId();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  useDismiss(onClose);
  const count: Record<Tab, number> = { schedules: lists.schedules.length, loops: lists.loops.length, monitors: lists.monitors.length };
  return (
    <div className="ws-overlay" onClick={onClose}>
      <aside className="ws-sheet auto-sheet" role="dialog" aria-modal="true" aria-labelledby={title} onClick={(e) => { e.stopPropagation(); }} data-testid="automation-sheet">
        <div className="ws-head">
          <h2 id={title} className="ws-title">Automations in this chat</h2>
          <button ref={close} type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="ws-tabs" role="tablist" aria-label="Kind">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`auto-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="auto-body" className="ws-tab" onClick={() => { onTab(t.id); }}>
              {t.label}{count[t.id] > 0 ? <span className="auto-tab-count">{count[t.id]}</span> : null}
            </button>
          ))}
        </div>
        <div id="auto-body" className="auto-body" role="tabpanel" aria-labelledby={`auto-tab-${tab}`}>
          <div className="auto-bar">
            <button type="button" className="btn primary" onClick={() => { onNew(tab); }} data-testid="automation-new">New {tab === "schedules" ? "schedule" : tab === "loops" ? "loop" : "monitor"}</button>
          </div>
          {count[tab] === 0 ? <p className="auto-empty" data-testid="automation-empty">{EMPTY_TEXT[tab]}</p> : null}
          <ul className="auto-list">
            {tab === "schedules" ? lists.schedules.map((s) => <ScheduleRow key={s.id} chatId={chatId} s={s} onEdit={onEdit} refresh={refresh} />) : null}
            {tab === "loops" ? lists.loops.map((l) => <LoopRow key={l.id} chatId={chatId} l={l} refresh={refresh} />) : null}
            {tab === "monitors" ? lists.monitors.map((m) => <MonitorRow key={m.id} chatId={chatId} m={m} refresh={refresh} />) : null}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="auto-status">
      <span className={`auto-dot is-${tone}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function LogView({ load }: { load: () => Promise<ApiResult<{ entries: LogEntry[] }>> }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void load().then((res) => {
      if (!live) return;
      if (res.kind === "ok") setEntries(res.body.entries);
      else setFailed(true);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaded once when the log opens
  }, []);
  if (failed) return <p className="auto-dim" role="alert">The log could not be read.</p>;
  if (entries === null) return <p className="auto-dim">Loading…</p>;
  if (entries.length === 0) return <p className="auto-dim" data-testid="automation-log-empty">Nothing recorded yet.</p>;
  return (
    <ul className="auto-log" data-testid="automation-log">
      {entries.map((e, i) => (
        // eslint-disable-next-line react/no-array-index-key -- log lines have no id
        <li key={i}><span className="mono auto-dim">{e.at.startsWith("20") ? rel(e.at) : e.at}</span> <span className={`auto-log-status${e.status === "failed" ? " is-failed" : ""}`}>{e.status}</span> <span dir="auto">{e.text}</span></li>
      ))}
    </ul>
  );
}

function useAct(refresh: () => void): (work: Promise<ApiResult<unknown>>, ok?: string) => Promise<boolean> {
  const toast = useToast();
  return async (work, ok) => {
    const res = await work;
    refresh();
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "that did not work"));
      return false;
    }
    if (ok !== undefined) toast("ok", ok);
    return true;
  };
}

function ScheduleRow({ chatId, s, onEdit, refresh }: { chatId: string; s: Schedule; onEdit: (s: Schedule) => void; refresh: () => void }) {
  const act = useAct(refresh);
  const confirm = useConfirm();
  const [log, setLog] = useState(false);
  const last = lastResult(s);
  const tone = scheduleTone(s);
  return (
    <li className="auto-item" data-testid="schedule-row">
      <div className="auto-item-head">
        <span className="auto-name" dir="auto">{s.name}</span>
        <Toggle label={`${s.enabled ? "Pause" : "Resume"} ${s.name}`} on={s.enabled} onChange={(on) => void act(automationApi.scheduleAction(chatId, s.id, on ? "resume" : "pause"))} />
      </div>
      <p className="auto-sum">{scheduleSummary(s)}</p>
      <p className="auto-meta">
        {s.enabled && s.next_at !== null ? <span>Next in {until(s.next_at)}</span> : <span>{s.pause_reason ?? "Paused"}</span>}
        <StatusDot tone={tone === "paused" && s.runs[0] !== undefined ? lastResult(s).tone : tone} label={last.label} />
      </p>
      <div className="auto-actions">
        <button type="button" className="btn" onClick={() => void act(automationApi.scheduleAction(chatId, s.id, "run-now"), "Ran it once")}>Run now</button>
        <button type="button" className="btn" onClick={() => { onEdit(s); }}>Edit</button>
        <button type="button" className="btn" aria-expanded={log} onClick={() => { setLog(!log); }}>Log</button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void confirm({ title: "Delete this schedule?", body: `“${s.name}” and its history are removed. Messages it already posted stay in the chat.`, confirmLabel: "Delete", danger: true }).then((yes) => {
              if (yes) void act(automationApi.deleteSchedule(chatId, s.id), "Schedule deleted");
            });
          }}
        >
          Delete
        </button>
      </div>
      {log ? <LogView load={() => automationApi.scheduleLog(chatId, s.id)} /> : null}
    </li>
  );
}

function LoopRow({ chatId, l, refresh }: { chatId: string; l: ChatLoop; refresh: () => void }) {
  const act = useAct(refresh);
  const [log, setLog] = useState(false);
  const running = l.status === "running";
  return (
    <li className="auto-item" data-testid="loop-row">
      <div className="auto-item-head">
        <span className="auto-name" dir="auto">{l.label}</span>
        {running ? <button type="button" className="btn danger" onClick={() => void act(automationApi.loopAction(chatId, l.id, "stop"), "Loop stopped")}>Stop</button> : null}
      </div>
      <p className="auto-sum">{loopSummary(l)}</p>
      <p className="auto-meta">
        <span>{loopProgress(l)}</span>
        {running && l.next_tick > 0 ? <span>Next in {until(l.next_tick)}</span> : null}
        <StatusDot tone={itemTone(l.status)} label={running ? "Running" : l.status === "failed" ? "Failed" : l.status === "lost" ? "Lost" : "Ended"} />
      </p>
      <div className="auto-actions">
        {!running ? <button type="button" className="btn" onClick={() => void act(automationApi.loopAction(chatId, l.id, "resume"), "Loop resumed")}>Resume</button> : null}
        <button type="button" className="btn" aria-expanded={log} onClick={() => { setLog(!log); }}>Log</button>
      </div>
      {log ? <LogView load={() => automationApi.loopLog(chatId, l.id)} /> : null}
    </li>
  );
}

function MonitorRow({ chatId, m, refresh }: { chatId: string; m: ChatMonitor; refresh: () => void }) {
  const act = useAct(refresh);
  const [log, setLog] = useState(false);
  const running = m.status === "running";
  return (
    <li className="auto-item" data-testid="monitor-row">
      <div className="auto-item-head">
        <span className="auto-name" dir="auto">{m.name}</span>
        <Toggle label={`${running ? "Pause" : "Resume"} ${m.name}`} on={running} onChange={(on) => void act(automationApi.monitorAction(chatId, m.id, on ? "resume" : "pause"))} />
      </div>
      <p className="auto-sum">{monitorSummary(m)}</p>
      <p className="auto-meta">
        <span>{m.events} trigger{m.events === 1 ? "" : "s"}{m.last_event !== null ? `, last ${rel(m.last_event)}` : ""}</span>
        <span>{running ? `Ends ${monitorExpiry(m)}` : m.reason ?? "Stopped"}</span>
        <StatusDot tone={itemTone(m.status)} label={running ? "Watching" : m.status === "lost" ? "Lost" : "Stopped"} />
      </p>
      <div className="auto-actions">
        {running ? <button type="button" className="btn" onClick={() => void act(automationApi.monitorAction(chatId, m.id, "run-now"), "Checked")}>Check now</button> : null}
        {running ? <button type="button" className="btn danger" onClick={() => void act(automationApi.monitorAction(chatId, m.id, "stop"), "Monitor stopped")}>Stop</button> : null}
        <button type="button" className="btn" aria-expanded={log} onClick={() => { setLog(!log); }}>Log</button>
      </div>
      {log ? <LogView load={() => automationApi.monitorLog(chatId, m.id)} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------- creation sheet

function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string | undefined; hint?: string | undefined; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="auto-field">
      <label className="auto-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined && error === undefined ? <p className="auto-dim">{hint}</p> : null}
      {error !== undefined ? <p className="auto-error" role="alert">{error}</p> : null}
    </div>
  );
}

function Chips({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<{ id: string; label: string }>; onChange: (id: string) => void }) {
  return (
    <div className="auto-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="auto-chip" aria-pressed={value === o.id} onClick={() => { onChange(o.id); }}>{o.label}</button>
      ))}
    </div>
  );
}

const MODES = [
  { id: "message", label: "Continue this chat" },
  { id: "fresh", label: "Fresh session" },
];
const MODE_HELP: Record<string, string> = {
  message: "Adds the prompt to this chat as a message. The agent remembers the conversation. It waits if a reply is running.",
  fresh: "Runs in a new session with this chat's folder and model, then posts only the answer here.",
};
const TITLES: Record<Tab, string> = { schedules: "Schedule this", loops: "Repeat a prompt", monitors: "Watch something" };

function ScheduleForm({ draft, set, errors }: { draft: ScheduleDraft; set: (d: ScheduleDraft) => void; errors: Record<string, string | undefined> }) {
  const id = useId();
  const preview = previewOf(draft, Math.floor(Date.now() / 1000));
  const zones = useMemo<string[]>(() => ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []), []);
  const up = (patch: Partial<ScheduleDraft>): void => { set({ ...draft, ...patch }); };
  return (
    <>
      <Field label="What" htmlFor={`${id}-what`} error={errors.prompt}>
        <textarea id={`${id}-what`} className="input auto-text" dir="auto" rows={3} value={draft.prompt} placeholder="The prompt to run" onChange={(e) => { up({ prompt: e.target.value, ...(draft.name === "" || draft.name === nameFrom(draft.prompt) ? { name: nameFrom(e.target.value) } : {}) }); }} />
      </Field>
      <Field label="When" error={errors.when}>
        <Chips label="When" value={draft.preset} options={SCHEDULE_PRESETS} onChange={(preset) => { up({ preset }); }} />
        {draft.preset === "once" ? <input type="datetime-local" className="input" aria-label="Date and time" value={draft.once} onChange={(e) => { up({ once: e.target.value }); }} /> : null}
        {draft.preset === "custom" ? <input className="input mono" aria-label="Cron expression" placeholder="0 9 * * 1-5" dir="ltr" value={draft.custom} onChange={(e) => { up({ custom: e.target.value }); }} /> : null}
        <div className="auto-preview" data-testid="schedule-preview" aria-live="polite">
          {preview.text !== "" ? <p className="auto-preview-text" data-testid="cron-text">{preview.text}</p> : null}
          {preview.runs.length > 0 ? <ol className="auto-runs">{preview.runs.map((r) => <li key={r}>{r}</li>)}</ol> : null}
        </div>
      </Field>
      <Field label="Mode">
        <Chips label="Mode" value={draft.mode} options={MODES} onChange={(mode) => { up({ mode: mode as ScheduleDraft["mode"] }); }} />
        <p className="auto-dim" data-testid="mode-help">{MODE_HELP[draft.mode]}</p>
      </Field>
      <div className="auto-two">
        <Field label="Name" htmlFor={`${id}-name`} error={errors.name}>
          <input id={`${id}-name`} className="input" dir="auto" value={draft.name} onChange={(e) => { up({ name: e.target.value }); }} />
        </Field>
        <Field label="Time zone" htmlFor={`${id}-tz`} error={errors.timezone}>
          <input id={`${id}-tz`} className="input" list={`${id}-zones`} dir="ltr" value={draft.timezone} onChange={(e) => { up({ timezone: e.target.value }); }} />
          <datalist id={`${id}-zones`}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
      </div>
    </>
  );
}

const STOPS = [
  { id: "none", label: "Never" },
  { id: "text", label: "When this is true" },
  { id: "regex", label: "Reply matches" },
  { id: "command", label: "Command succeeds" },
];
const STOP_HELP: Record<string, string> = {
  text: "A short sentence the agent judges after each iteration, e.g. the build is green.",
  regex: "A regular expression tested against each reply.",
  command: "A shell command; the loop stops when it exits 0.",
};

function LoopForm({ draft, set, errors }: { draft: LoopDraft; set: (d: LoopDraft) => void; errors: Record<string, string | undefined> }) {
  const id = useId();
  const up = (patch: Partial<LoopDraft>): void => { set({ ...draft, ...patch }); };
  return (
    <>
      <Field label="Prompt" htmlFor={`${id}-p`} error={errors.prompt}>
        <textarea id={`${id}-p`} className="input auto-text" dir="auto" rows={3} value={draft.prompt} placeholder="What to do each time" onChange={(e) => { up({ prompt: e.target.value, ...(draft.label === "" || draft.label === nameFrom(draft.prompt) ? { label: nameFrom(e.target.value) } : {}) }); }} />
      </Field>
      <Field label="Repeat" error={errors.minutes}>
        <Chips label="Repeat" value={draft.cadence} options={[{ id: "interval", label: "Every N minutes" }, { id: "done", label: "When the last one is done" }]} onChange={(c) => { up({ cadence: c as LoopDraft["cadence"] }); }} />
        {draft.cadence === "interval" ? (
          <label className="auto-inline">Every <input className="input auto-num" inputMode="decimal" aria-label="Minutes" value={draft.minutes} onChange={(e) => { up({ minutes: e.target.value }); }} /> minutes</label>
        ) : <p className="auto-dim">Starts the next one about 10 seconds after the last finishes.</p>}
      </Field>
      <div className="auto-two">
        <Field label="Max iterations" htmlFor={`${id}-max`} error={errors.max} hint="Empty means no limit.">
          <input id={`${id}-max`} className="input" inputMode="numeric" value={draft.max} onChange={(e) => { up({ max: e.target.value }); }} />
        </Field>
        <Field label="Name" htmlFor={`${id}-n`} error={errors.label}>
          <input id={`${id}-n`} className="input" dir="auto" value={draft.label} onChange={(e) => { up({ label: e.target.value }); }} />
        </Field>
      </div>
      <Field label="Stop" error={errors.stop} hint={STOP_HELP[draft.stopKind]}>
        <Chips label="Stop" value={draft.stopKind} options={STOPS} onChange={(k) => { up({ stopKind: k as LoopDraft["stopKind"] }); }} />
        {draft.stopKind !== "none" ? <input className="input" aria-label="Stop condition" dir="auto" value={draft.stop} onChange={(e) => { up({ stop: e.target.value }); }} /> : null}
      </Field>
      <Field label="Mode">
        <Chips label="Mode" value={draft.mode} options={MODES} onChange={(mode) => { up({ mode: mode as LoopDraft["mode"] }); }} />
        <p className="auto-dim">{draft.mode === "message" ? "Each iteration continues this chat and posts its answer here." : "Each iteration runs fresh and posts its answer here as a result block."}</p>
      </Field>
      <p className="auto-dim">Also stops after 3 failures in a row, and when you press Stop.</p>
    </>
  );
}

const CONDITIONS: Record<string, ReadonlyArray<{ id: string; label: string }>> = {
  url: [{ id: "status", label: "Status changes" }, { id: "text", label: "Text changes" }],
  command: [{ id: "exit", label: "Exit code changes" }, { id: "regex", label: "Output matches" }],
  git: [{ id: "commits", label: "New commits" }, { id: "ci", label: "CI status" }],
};

function MonitorForm({ draft, set, errors }: { draft: MonitorDraft; set: (d: MonitorDraft) => void; errors: Record<string, string | undefined> }) {
  const id = useId();
  const kind = MONITOR_TYPES.find((t) => t.id === draft.type) ?? MONITOR_TYPES[0]!;
  const up = (patch: Partial<MonitorDraft>): void => { set({ ...draft, ...patch }); };
  const conds = CONDITIONS[draft.type];
  const pattern = (draft.type === "command" && draft.condition === "regex") || draft.type === "stream" || draft.type === "run";
  return (
    <>
      <Field label="What to watch" error={errors.target} hint={kind.hint}>
        <Chips label="What to watch" value={draft.type} options={MONITOR_TYPES} onChange={(t) => { set({ ...emptyMonitorDraft(draft.target, t as MonitorDraft["type"]), name: draft.name, repeat: draft.repeat, then: draft.then, thenPrompt: draft.thenPrompt }); }} />
        <input className="input" aria-label="Target" dir="ltr" placeholder={kind.target} value={draft.target} onChange={(e) => { up({ target: e.target.value, ...(draft.name === "" ? { name: e.target.value.slice(0, 40) } : {}) }); }} />
      </Field>
      {conds !== undefined ? (
        <Field label="Condition">
          <Chips label="Condition" value={draft.condition} options={conds} onChange={(condition) => { up({ condition }); }} />
        </Field>
      ) : null}
      {pattern ? (
        <Field label={draft.type === "run" ? "Which states (regex)" : "Pattern (regex)"} htmlFor={`${id}-pat`} error={errors.pattern} hint={draft.type === "run" ? "Empty means finished, failed or stalled." : undefined}>
          <input id={`${id}-pat`} className="input mono" dir="ltr" value={draft.pattern} onChange={(e) => { up({ pattern: e.target.value }); }} />
        </Field>
      ) : null}
      <div className="auto-two">
        {draft.type !== "stream" ? (
          <Field label="Check every (seconds)" htmlFor={`${id}-ev`} error={errors.every}>
            <input id={`${id}-ev`} className="input" inputMode="numeric" value={draft.every} onChange={(e) => { up({ every: e.target.value }); }} />
          </Field>
        ) : null}
        <Field label="Ends after" htmlFor={`${id}-ex`} error={errors.expiry} hint="e.g. 6h or 2d">
          <input id={`${id}-ex`} className="input" value={draft.expiry} onChange={(e) => { up({ expiry: e.target.value }); }} />
        </Field>
      </div>
      <div className="auto-two">
        <Field label="Triggers">
          <Chips label="Triggers" value={draft.repeat} options={[{ id: "repeat", label: "Every time" }, { id: "once", label: "Once" }]} onChange={(r) => { up({ repeat: r as MonitorDraft["repeat"] }); }} />
        </Field>
        <Field label="Group triggers within (seconds)" htmlFor={`${id}-db`} hint="0 posts each one.">
          <input id={`${id}-db`} className="input" inputMode="numeric" value={draft.debounce} onChange={(e) => { up({ debounce: e.target.value }); }} />
        </Field>
      </div>
      <Field label="Then" error={errors.thenPrompt}>
        <Chips label="Then" value={draft.then} options={[{ id: "tell", label: "Tell me" }, { id: "act", label: "Ask the agent to act" }]} onChange={(t) => { up({ then: t as MonitorDraft["then"] }); }} />
        {draft.then === "act" ? <textarea className="input auto-text" dir="auto" rows={2} aria-label="What the agent should do" value={draft.thenPrompt} onChange={(e) => { up({ thenPrompt: e.target.value }); }} /> : null}
      </Field>
      <Field label="Name" htmlFor={`${id}-mn`} error={errors.name}>
        <input id={`${id}-mn`} className="input" dir="auto" value={draft.name} onChange={(e) => { up({ name: e.target.value }); }} />
      </Field>
    </>
  );
}

function userPrompt(text: string): string {
  const m = /^Scheduled: .*\n\n([\s\S]*)$/.exec(text);
  return m === null ? text : m[1]!;
}

function CreateSheet({ chatId, create, onClose, onDone }: { chatId: string; create: NonNullable<Create>; onClose: () => void; onDone: (kind: Tab) => void }) {
  const toast = useToast();
  const title = useId();
  const prefill = userPrompt(create.prefill);
  const editing = create.editing;
  const [sched, setSched] = useState<ScheduleDraft>(() => (editing !== undefined ? draftOfSchedule(editing) : emptyScheduleDraft(prefill)));
  const [loop, setLoop] = useState<LoopDraft>(() => emptyLoopDraft(prefill));
  const [mon, setMon] = useState<MonitorDraft>(() => {
    const spec = guessMonitor(prefill);
    return prefill.trim() === "" ? emptyMonitorDraft() : { ...emptyMonitorDraft(spec.target, spec.type), condition: spec.condition ?? "" };
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useDismiss(onClose);
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => { first.current?.querySelector<HTMLElement>("textarea, input")?.focus(); }, []);

  const save = async (): Promise<void> => {
    setProblem(null);
    let res: ApiResult<unknown>;
    if (create.kind === "schedules") {
      const { body, errors: e } = scheduleBody(sched);
      setErrors(e);
      if (body === null) return;
      setBusy(true);
      res = editing !== undefined
        ? await automationApi.editSchedule(chatId, editing.id, { name: body.name, prompt: body.prompt, cron: body.cron, timezone: body.timezone ?? "", mode: body.mode ?? "message" })
        : await automationApi.createSchedule(chatId, body);
    } else if (create.kind === "loops") {
      const { body, errors: e } = loopBody(loop);
      setErrors(e);
      if (body === null) return;
      setBusy(true);
      res = await automationApi.createLoop(chatId, body);
    } else {
      const { body, errors: e } = monitorBody(mon);
      setErrors(e);
      if (body === null) return;
      setBusy(true);
      res = await automationApi.createMonitor(chatId, body);
    }
    setBusy(false);
    if (res.kind !== "ok") {
      setProblem(describeFailure(res, "could not save"));
      return;
    }
    toast("ok", create.kind === "schedules" ? (editing !== undefined ? "Schedule saved" : "Schedule saved. Its result returns to this chat.") : create.kind === "loops" ? "Loop started" : "Monitor started");
    onDone(create.kind);
  };

  return (
    <div className="auto-overlay" onClick={onClose}>
      <div className="auto-create" role="dialog" aria-modal="true" aria-labelledby={title} onClick={(e) => { e.stopPropagation(); }} data-testid="automation-create">
        <h2 id={title} className="ws-title">{editing !== undefined ? "Edit schedule" : TITLES[create.kind]}</h2>
        <div ref={first} className="auto-form">
          {create.kind === "schedules" ? <ScheduleForm draft={sched} set={setSched} errors={errors} /> : null}
          {create.kind === "loops" ? <LoopForm draft={loop} set={setLoop} errors={errors} /> : null}
          {create.kind === "monitors" ? <MonitorForm draft={mon} set={setMon} errors={errors} /> : null}
        </div>
        {problem !== null ? <p className="auto-error" role="alert" data-testid="automation-problem">{problem}</p> : null}
        <div className="auto-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()} data-testid="automation-save">
            {busy ? "Saving…" : editing !== undefined ? "Save" : create.kind === "schedules" ? "Save schedule" : create.kind === "loops" ? "Start loop" : "Start monitor"}
          </button>
        </div>
      </div>
    </div>
  );
}
