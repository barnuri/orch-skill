import type { Schedule, ScheduleInput, ScheduleKind, ScheduleRun } from "../../../shared/types/schedule";
import { ApiClient } from "../api/api-client";
import { emptyState } from "../components/empty-state";
import { kpiTile } from "../components/kpi-tile";
import { skeletonRows } from "../components/skeleton";
import { runStrip } from "../components/run-strip";
import { toggle } from "../components/toggle";
import { labelled, segmented } from "../components/segmented";
import { el } from "../dom/el";
import { fmtDur, rel, until } from "../dom/format";
import { poll } from "../poll";
import { render } from "../render";
import type { AppState } from "../state/app-state";
import { state } from "../state/state";
import { confirmDialog } from "../ui/confirm-dialog";
import { toast } from "../ui/toast";
import { pageHead } from "./page-head";

const api = new ApiClient();

const CUSTOM: string = "custom";
const PRESETS: readonly { label: string; cron: string }[] = [
  { label: "Every minute", cron: "* * * * *" },
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
];

interface Draft {
  name: string;
  kind: ScheduleKind;
  cron: string;
  profile: string;
  prompt: string;
  command: string;
  workdir: string;
  timeout: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  kind: "prompt",
  cron: "0 9 * * 1-5",
  profile: "",
  prompt: "",
  command: "",
  workdir: "",
  timeout: "",
});

let draft: Draft = emptyDraft();
let formOpen = false;
let formError: string | null = null;
let saving = false;
const expanded: Set<string> = new Set();
const logs: Map<string, string> = new Map();
const busy: Set<string> = new Set();

function cronLabel(cron: string): string {
  return PRESETS.find((preset) => preset.cron === cron)?.label ?? "Custom schedule";
}

// The next poll must refetch, so the list reflects what was just changed.
function refresh(): void {
  state.schedulesEtag = null;
  void poll();
}

function openForm(): void {
  formOpen = true;
  render();
}

function statusChip(status: string | null): HTMLElement {
  if (status === null) {
    return el("span", { class: "chip waiting", text: "never run" });
  }
  return el("span", { class: `chip ${status === "ok" ? "done" : status}`, text: status === "ok" ? "ok" : status });
}

async function act(schedule: Schedule, action: "run" | "enable" | "disable", button: HTMLButtonElement): Promise<void> {
  busy.add(schedule.id);
  button.disabled = true;
  const result = await api.scheduleAction(schedule.id, action);
  busy.delete(schedule.id);
  if (result.kind !== "ok") {
    button.disabled = false;
    toast("error", result.kind === "error" ? (result.body?.error ?? `failed (${result.status})`) : "could not reach the dashboard");
    return;
  }
  toast("ok", action === "run" ? `Started ${schedule.name}` : `${schedule.name} ${action}d`);
  refresh();
}

async function remove(schedule: Schedule): Promise<void> {
  const confirmed = await confirmDialog({
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
    toast("error", result.kind === "error" ? (result.body?.error ?? `failed (${result.status})`) : "could not reach the dashboard");
    return;
  }
  expanded.delete(schedule.id);
  refresh();
}

async function loadLog(schedule: Schedule, index: number, run: ScheduleRun): Promise<void> {
  const key = `${schedule.id}:${run.started_at}`;
  logs.set(key, "Loading…");
  render();
  const result = await api.getScheduleRunLog(schedule.id, index);
  logs.set(key, result.kind === "ok" ? result.body.text : "Could not load the output.");
  render();
}

function runRow(schedule: Schedule, run: ScheduleRun, index: number): HTMLElement {
  const key = `${schedule.id}:${run.started_at}`;
  const open = logs.has(key);
  const view = el("button", { class: "btn sched-view", type: "button", text: open ? "Reload output" : "Output" });
  view.addEventListener("click", () => {
    void loadLog(schedule, index, run);
  });
  const row = el("div", { class: "sched-run" }, [
    statusChip(run.status),
    el("span", { class: "sched-run-time", text: rel(run.started_at) }),
    el("span", { class: "muted", text: run.status === "running" ? "running…" : fmtDur(run.started_at, run.ended_at) }),
    el("span", { class: "muted mono", text: run.exit === null ? "" : `exit ${run.exit}` }),
    view,
  ]);
  const wrap = el("div", { class: "sched-run-wrap" }, [row]);
  const text = logs.get(key);
  if (text !== undefined) {
    wrap.appendChild(el("pre", { class: "sched-log", text: text.length > 0 ? text : "(no output)" }));
  }
  return wrap;
}

type Health = "failing" | "running" | "paused" | "ok" | "new";
type Filter = "all" | "active" | "paused" | "failing";
// Rows that need a look come first: failing, then running, then the rest, paused last.
const ATTENTION: Record<Health, number> = { failing: 0, running: 1, ok: 2, new: 3, paused: 4 };
const COUNTDOWN_ATTR: string = "data-next";
let filter: Filter = "all";

function healthOf(schedule: Schedule): Health {
  if (!schedule.enabled) {
    return "paused";
  }
  if (schedule.last_status === "running") {
    return "running";
  }
  if (schedule.last_status === "failed" || schedule.last_status === "lost") {
    return "failing";
  }
  return schedule.last_status === null ? "new" : "ok";
}

function nextCell(schedule: Schedule): HTMLElement {
  if (!schedule.enabled) {
    return el("div", { class: "sched-next" }, [el("span", { class: "sched-next-label", text: "next run" }), el("span", { class: "sched-next-value muted", text: "paused" })]);
  }
  if (schedule.next_at === null) {
    return el("div", { class: "sched-next" }, [el("span", { class: "sched-next-label", text: "next run" }), el("span", { class: "sched-next-value muted", text: "none" })]);
  }
  const value = el("span", { class: "sched-next-value", text: until(schedule.next_at), [COUNTDOWN_ATTR]: String(schedule.next_at) });
  return el("div", { class: "sched-next" }, [el("span", { class: "sched-next-label", text: "next run in" }), value]);
}

/** Updates the countdowns in place each second, without rebuilding the page. */
export function tickSchedules(): void {
  for (const node of document.querySelectorAll<HTMLElement>(`[${COUNTDOWN_ATTR}]`)) {
    const next = Number(node.getAttribute(COUNTDOWN_ATTR));
    if (next > 0) {
      node.textContent = until(next);
    }
  }
}

function scheduleRow(schedule: Schedule): HTMLElement {
  const isOpen = expanded.has(schedule.id);
  const health = healthOf(schedule);
  const row = el("article", { class: `sched-row is-${health}` });

  const what =
    schedule.kind === "prompt"
      ? `${schedule.profile ?? ""} · ${schedule.prompt ?? ""}`
      : `${schedule.workdir === null ? "" : `${schedule.workdir} · `}${schedule.command ?? ""}`;
  const title = el("div", { class: "sched-title" }, [
    el("div", { class: "sched-head" }, [
      el("h3", { class: "sched-name", text: schedule.name }),
      el("span", { class: "sched-kind", text: schedule.kind }),
      health === "paused" ? el("span", { class: "chip default", text: "paused" }) : statusChip(schedule.last_status),
    ]),
    el("div", { class: "sched-sub" }, [
      el("span", { class: "mono", text: schedule.cron }),
      el("span", { class: "muted", text: cronLabel(schedule.cron) }),
    ]),
    el("div", { class: "sched-what mono", text: what, title: what }),
  ]);
  const history = el("div", { class: "sched-history" }, [
    runStrip(schedule.runs),
    schedule.last_run_at === null ? null : el("span", { class: "sched-last", text: `last run ${rel(schedule.last_run_at)}` }),
  ]);

  const enable = toggle(schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`, schedule.enabled, (next) => {
    void act(schedule, next ? "enable" : "disable", enable);
  });
  const runNow = el("button", { class: "btn", type: "button", text: "Run now" });
  runNow.addEventListener("click", () => {
    void act(schedule, "run", runNow);
  });
  const runs = el("button", {
    class: "btn",
    type: "button",
    "aria-expanded": String(isOpen),
    text: isOpen ? "Hide runs" : `Runs (${schedule.runs.length})`,
  });
  runs.addEventListener("click", () => {
    if (expanded.has(schedule.id)) {
      expanded.delete(schedule.id);
    } else {
      expanded.add(schedule.id);
    }
    render();
  });
  if (busy.has(schedule.id)) {
    runNow.disabled = true;
    enable.disabled = true;
  }
  const actions = el("div", { class: "sched-actions" }, [enable, runNow, runs]);
  row.append(title, history, nextCell(schedule), actions);

  if (isOpen) {
    const detail = el("div", { class: "sched-detail" });
    if (schedule.prompt !== null || schedule.command !== null) {
      detail.appendChild(el("pre", { class: "sched-full", text: schedule.prompt ?? schedule.command ?? "" }));
    }
    if (schedule.runs.length === 0) {
      detail.appendChild(el("p", { class: "sub", text: "No runs yet. Use Run now to try it." }));
    }
    schedule.runs.forEach((run, index) => detail.appendChild(runRow(schedule, run, index)));
    const del = el("button", { class: "btn danger", type: "button", text: "Delete schedule" });
    del.addEventListener("click", () => {
      void remove(schedule);
    });
    detail.appendChild(el("div", { class: "sched-detail-foot" }, [del]));
    row.appendChild(detail);
  }
  return row;
}

function input(label: string, key: keyof Draft, placeholder: string, mono = false): HTMLElement {
  const field = el("input", { type: "text", value: draft[key], placeholder, class: mono ? "mono" : "" });
  field.addEventListener("input", () => {
    draft[key] = field.value as never;
  });
  return labelled(label, field);
}

function textarea(label: string, key: keyof Draft, placeholder: string, rows: string): HTMLElement {
  const field = el("textarea", { placeholder, rows }, [draft[key]]);
  field.addEventListener("input", () => {
    draft[key] = field.value as never;
  });
  return labelled(label, field);
}

function cronField(): HTMLElement {
  const known = PRESETS.some((preset) => preset.cron === draft.cron);
  const select = el("select", { "aria-label": "Preset" });
  for (const preset of PRESETS) {
    select.appendChild(el("option", { value: preset.cron, text: preset.label }));
  }
  select.appendChild(el("option", { value: CUSTOM, text: "Custom…" }));
  select.value = known ? draft.cron : CUSTOM;
  const cron = el("input", { type: "text", value: draft.cron, class: "mono", "aria-label": "Cron expression", placeholder: "m h dom mon dow" });
  cron.addEventListener("input", () => {
    draft.cron = cron.value;
  });
  select.addEventListener("change", () => {
    if (select.value !== CUSTOM) {
      draft.cron = select.value;
      cron.value = select.value;
    }
  });
  const preview = el("div", { class: "sched-preview", role: "status", "aria-live": "polite" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshPreview = (): void => {
    clearTimeout(timer);
    const value = cron.value.trim();
    timer = setTimeout(() => {
      void api.previewSchedule(value).then((result) => {
        if (result.kind === "ok") {
          preview.className = "sched-preview is-ok";
          preview.textContent = `Next run: ${result.body.next}`;
        } else if (result.kind === "error") {
          preview.className = "sched-preview is-bad";
          preview.textContent = result.body?.error ?? "not a valid cron expression";
        }
      });
    }, 250);
  };
  cron.addEventListener("input", refreshPreview);
  select.addEventListener("change", refreshPreview);
  refreshPreview();
  return labelled("When", el("div", { class: "sched-when-wrap" }, [el("div", { class: "sched-when" }, [select, cron]), preview]));
}

function payload(): ScheduleInput {
  const base: ScheduleInput = { name: draft.name.trim(), cron: draft.cron.trim(), kind: draft.kind };
  if (draft.kind === "prompt") {
    return { ...base, prompt: draft.prompt, profile: draft.profile };
  }
  const out: ScheduleInput = { ...base, command: draft.command };
  if (draft.workdir.trim() !== "") {
    out.workdir = draft.workdir.trim();
  }
  if (draft.timeout.trim() !== "") {
    out.timeout = draft.timeout.trim();
  }
  return out;
}

async function submit(): Promise<void> {
  if (draft.kind === "prompt" && draft.profile === "") {
    draft.profile = state.defaultProfile || state.profileNames[0] || "";
  }
  saving = true;
  formError = null;
  render();
  const result = await api.createSchedule(payload());
  saving = false;
  if (result.kind === "ok") {
    toast("ok", `Created ${draft.name.trim()}`);
    draft = emptyDraft();
    formOpen = false;
    refresh();
    render();
    return;
  }
  formError =
    result.kind === "error" ? (result.body?.error ?? `failed (${result.status})`) : "could not reach the dashboard";
  render();
}

function form(current: AppState): HTMLElement {
  if (draft.kind === "prompt" && draft.profile === "") {
    draft.profile = current.defaultProfile || current.profileNames[0] || "";
  }
  const box = el("section", { class: "panel-box sched-form" });
  const kind = segmented(
    "What to run",
    draft.kind,
    [
      { value: "prompt", label: "Prompt" },
      { value: "command", label: "Shell command" },
    ],
    (next) => {
      draft.kind = next as ScheduleKind;
      render();
    },
  );
  box.appendChild(el("div", { class: "sched-form-row" }, [input("Name", "name", "Morning repo summary"), labelled("Runs a", kind)]));
  box.appendChild(cronField());

  if (draft.kind === "prompt") {
    const profile = el("select", { "aria-label": "Profile" });
    for (const name of current.profileNames) {
      profile.appendChild(el("option", { value: name, text: name }));
    }
    profile.value = draft.profile;
    profile.addEventListener("change", () => {
      draft.profile = profile.value;
    });
    box.appendChild(labelled("Profile", profile));
    box.appendChild(textarea("Prompt", "prompt", "What should the agent do each time?", "4"));
  } else {
    box.appendChild(textarea("Command", "command", "git -C ~/repo pull && ./scripts/report.sh", "3"));
    box.appendChild(
      el("div", { class: "sched-form-row" }, [
        input("Working directory (optional)", "workdir", "/Users/you/repo", true),
        input("Time limit (optional)", "timeout", "30m, default 1h", true),
      ]),
    );
  }
  if (formError !== null) {
    box.appendChild(el("div", { class: "notice", role: "alert", text: formError }));
  }
  const create = el("button", { class: "btn primary", type: "button", text: saving ? "Creating…" : "Create schedule" });
  create.disabled = saving;
  create.addEventListener("click", () => {
    void submit();
  });
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  cancel.addEventListener("click", () => {
    formOpen = false;
    formError = null;
    render();
  });
  box.appendChild(el("div", { class: "sched-form-actions" }, [cancel, create]));
  return box;
}

function summary(list: readonly Schedule[]): HTMLElement {
  const active = list.filter((s) => s.enabled);
  const running = list.filter((s) => s.enabled && s.last_status === "running").length;
  const failing = list.filter((s) => healthOf(s) === "failing").length;
  const upcoming = active.map((s) => s.next_at).filter((n): n is number => n !== null);
  const soonest = upcoming.length === 0 ? null : Math.min(...upcoming);
  const next = kpiTile("Next run in", soonest === null ? "—" : until(soonest), soonest === null ? "nothing scheduled" : "across all schedules", soonest === null ? "neutral" : "acc");
  if (soonest !== null) {
    next.querySelector(".kpi-value")?.setAttribute(COUNTDOWN_ATTR, String(soonest));
  }
  const row = el("div", { class: "kpis" });
  row.append(
    kpiTile("Active", `${active.length}/${list.length}`, active.length === list.length ? "all running on time" : `${list.length - active.length} paused`, active.length > 0 ? "ok" : "neutral"),
    next,
    kpiTile("Running now", String(running), running > 0 ? "runs in progress" : "idle", running > 0 ? "acc" : "neutral"),
    kpiTile("Needs attention", String(failing), failing > 0 ? "last run failed or was lost" : "all clear", failing > 0 ? "er" : "ok"),
  );
  return row;
}

function filterBar(list: readonly Schedule[]): HTMLElement {
  const count = (f: Filter): number => list.filter((s) => matches(s, f)).length;
  return labelled(
    "Show",
    segmented(
      "Filter schedules",
      filter,
      (["all", "active", "paused", "failing"] as const).map((f) => ({ value: f, label: `${f[0]?.toUpperCase()}${f.slice(1)} ${count(f)}` })),
      (next) => {
        filter = next as Filter;
        render();
      },
    ),
  );
}

function matches(schedule: Schedule, f: Filter): boolean {
  if (f === "all") {
    return true;
  }
  if (f === "active") {
    return schedule.enabled;
  }
  if (f === "paused") {
    return !schedule.enabled;
  }
  return healthOf(schedule) === "failing";
}

/** The `#/schedules` page: cron schedules that run a prompt or a shell command. */
export function renderSchedules(current: AppState): DocumentFragment {
  const frag = document.createDocumentFragment();
  const add = el("button", { class: "btn primary", type: "button", text: "New schedule" });
  add.addEventListener("click", openForm);
  const list = current.schedules;
  const sub =
    list === null
      ? "Loading…"
      : "Each one runs a prompt or a shell command on a cron timetable. The dashboard server checks them every 30 s.";
  frag.appendChild(pageHead("Schedules", sub, formOpen ? undefined : add));

  if (formOpen) {
    frag.appendChild(form(current));
  }
  if (list === null) {
    frag.appendChild(skeletonRows(3));
    return frag;
  }
  if (list.length === 0) {
    if (!formOpen) {
      frag.appendChild(
        emptyState(
          "No schedules yet",
          "Press New schedule to run a prompt or a shell command on a timetable. It keeps running while the dashboard server is up.",
        ),
      );
    }
    return frag;
  }
  frag.appendChild(summary(list));
  frag.appendChild(filterBar(list));
  const shown = list.filter((s) => matches(s, filter)).sort((a, b) => ATTENTION[healthOf(a)] - ATTENTION[healthOf(b)]);
  if (shown.length === 0) {
    frag.appendChild(emptyState(`No ${filter} schedules`, "Pick All to see every schedule."));
    return frag;
  }
  const ledger = el("div", { class: "panel-box sched-ledger" });
  for (const schedule of shown) {
    ledger.appendChild(scheduleRow(schedule));
  }
  frag.appendChild(ledger);
  return frag;
}
