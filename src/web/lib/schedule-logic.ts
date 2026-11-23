import type { Schedule, ScheduleEdit, ScheduleInput, ScheduleRun } from "../../shared/types/schedule";
import type { ChatOptions } from "./chat-types";

export type Health = "failing" | "running" | "paused" | "ok" | "new";
export type ScheduleFilter = "all" | "active" | "paused" | "failing";

export const FILTERS: readonly ScheduleFilter[] = ["all", "active", "paused", "failing"];

// Rows that need a look come first: failing, then running, then the rest, paused last.
const ATTENTION: Readonly<Record<Health, number>> = { failing: 0, running: 1, ok: 2, new: 3, paused: 4 };

export const CUSTOM_CRON = "custom";
export const CRON_PRESETS: readonly { label: string; cron: string }[] = [
  { label: "Every minute", cron: "* * * * *" },
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
];

export function cronLabel(cron: string): string {
  return CRON_PRESETS.find((preset) => preset.cron === cron)?.label ?? "Custom schedule";
}

export function healthOf(schedule: Schedule): Health {
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

export function matchesFilter(schedule: Schedule, filter: ScheduleFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "active") {
    return schedule.enabled;
  }
  if (filter === "paused") {
    return !schedule.enabled;
  }
  return healthOf(schedule) === "failing";
}

export function visibleSchedules(list: readonly Schedule[], filter: ScheduleFilter): Schedule[] {
  return list.filter((s) => matchesFilter(s, filter)).sort((a, b) => ATTENTION[healthOf(a)] - ATTENTION[healthOf(b)]);
}

export type BulkAction = "pause" | "resume";

/** Pause all takes the enabled schedules, Resume all the disabled ones. */
export function bulkTargets(list: readonly Schedule[], action: BulkAction): Schedule[] {
  return list.filter((s) => (action === "pause" ? s.enabled : !s.enabled));
}

export function soonestNext(list: readonly Schedule[]): number | null {
  const upcoming = list.filter((s) => s.enabled).map((s) => s.next_at).filter((n): n is number => n !== null);
  return upcoming.length === 0 ? null : Math.min(...upcoming);
}

export interface ScheduleDraft {
  name: string;
  /** Optional note on what the schedule is for. */
  description: string;
  kind: "prompt" | "command";
  cron: string;
  profile: string;
  /** Catalog model id; "" = the profile's default model. */
  model: string;
  prompt: string;
  command: string;
  workdir: string;
  timeout: string;
}

export const emptyScheduleDraft = (): ScheduleDraft => ({
  name: "",
  description: "",
  kind: "prompt",
  cron: "0 9 * * 1-5",
  profile: "",
  model: "",
  prompt: "",
  command: "",
  workdir: "",
  timeout: "",
});

export function schedulePayload(draft: ScheduleDraft): ScheduleInput {
  const description = (draft.description ?? "").trim();
  const base = { name: draft.name.trim(), cron: draft.cron.trim(), kind: draft.kind, ...(description === "" ? {} : { description }) } as const;
  if (draft.kind === "prompt") {
    const model = (draft.model ?? "").trim();
    return model === "" ? { ...base, prompt: draft.prompt, profile: draft.profile } : { ...base, prompt: draft.prompt, profile: draft.profile, model };
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

/** A stored time limit in seconds as the form shows it: 300 -> "5m", 0 -> "" (the default). */
export function timeoutText(secs: number): string {
  if (secs <= 0) {
    return "";
  }
  if (secs % 3600 === 0) {
    return `${secs / 3600}h`;
  }
  return secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`;
}

/** The form's draft for an existing schedule, so Edit opens the create form prefilled. */
export function draftOf(schedule: Schedule): ScheduleDraft {
  return {
    name: schedule.name,
    description: schedule.description ?? "",
    kind: schedule.kind,
    cron: schedule.cron,
    profile: schedule.profile ?? "",
    model: schedule.model ?? "",
    prompt: schedule.prompt ?? "",
    command: schedule.command ?? "",
    workdir: schedule.workdir ?? "",
    timeout: timeoutText(schedule.timeout),
  };
}

/**
 * The body of PUT /api/schedules/{id}: the whole form, so a cleared working directory or time limit
 * is cleared on the schedule too (an empty workdir and a 0 timeout mean "none").
 */
export function scheduleEditPayload(draft: ScheduleDraft): ScheduleEdit {
  const base = { name: draft.name.trim(), description: (draft.description ?? "").trim(), cron: draft.cron.trim(), kind: draft.kind } as const;
  if (draft.kind === "prompt") {
    const model = (draft.model ?? "").trim();
    return { ...base, prompt: draft.prompt, profile: draft.profile, model: model === "" ? null : model };
  }
  return { ...base, command: draft.command, workdir: draft.workdir.trim(), timeout: draft.timeout.trim() === "" ? "0" : draft.timeout.trim() };
}

export type DraftErrors = Partial<Record<"name" | "cron" | "prompt" | "profile" | "command" | "timeout", string>>;

/** What the form can tell before asking the server; the CLI still checks everything again. */
export function draftErrors(draft: ScheduleDraft): DraftErrors {
  const out: DraftErrors = {};
  if (draft.name.trim() === "") {
    out.name = "Give it a name.";
  }
  if (draft.cron.trim() === "") {
    out.cron = "Enter a cron expression.";
  }
  if (draft.kind === "prompt") {
    if (draft.prompt.trim() === "") {
      out.prompt = "Write the prompt.";
    }
    if (draft.profile === "") {
      out.profile = "Pick a profile.";
    }
  } else {
    if (draft.command.trim() === "") {
      out.command = "Enter a command.";
    }
    if (draft.timeout.trim() !== "" && !/^\d+[smhd]?$/.test(draft.timeout.trim())) {
      out.timeout = "Use a duration such as 30s, 5m or 1h.";
    }
  }
  return out;
}

/** What a schedule list row or run entry shows for a model: the id, or the placeholder for the profile's default. */
export const DEFAULT_MODEL_LABEL = "profile default";

export function modelText(item: Pick<Schedule, "model"> | Pick<ScheduleRun, "model">): string {
  return item.model === null || item.model === undefined || item.model === "" ? DEFAULT_MODEL_LABEL : item.model;
}

export interface ScheduleModelOption {
  value: string;
  label: string;
  detail?: string;
  description?: string;
}

/**
 * The model picker's rows for a profile, from the chat options (GET /api/chat-options): "Profile default"
 * first (naming the profile's own model when it has one), then every model the profile's harness and
 * allowed_models permit. A stored model the list no longer offers stays visible so an edit does not hide it.
 */
export function scheduleModelOptions(options: ChatOptions | undefined, profile: string, current: string): ScheduleModelOption[] {
  const found = options?.harnesses.flatMap((h) => h.profiles).find((p) => p.name === profile);
  const models = found?.models ?? [];
  const def = models.find((m) => m.default);
  const rows: ScheduleModelOption[] = [
    { value: "", label: "Profile default", ...(def === undefined ? {} : { detail: def.id }), description: "Whatever model the profile is set to when the schedule fires." },
    ...models.map((m) => ({ value: m.id, label: m.label, detail: m.slug, ...(m.description === "" ? {} : { description: m.description }) })),
  ];
  if (current !== "" && !models.some((m) => m.id === current)) {
    rows.splice(1, 0, { value: current, label: current, description: "Not offered for this profile any more." });
  }
  return rows;
}
