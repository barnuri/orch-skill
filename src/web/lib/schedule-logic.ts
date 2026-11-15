import type { Schedule, ScheduleInput } from "../../shared/types/schedule";

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

export function soonestNext(list: readonly Schedule[]): number | null {
  const upcoming = list.filter((s) => s.enabled).map((s) => s.next_at).filter((n): n is number => n !== null);
  return upcoming.length === 0 ? null : Math.min(...upcoming);
}

export interface ScheduleDraft {
  name: string;
  kind: "prompt" | "command";
  cron: string;
  profile: string;
  prompt: string;
  command: string;
  workdir: string;
  timeout: string;
}

export const emptyScheduleDraft = (): ScheduleDraft => ({
  name: "",
  kind: "prompt",
  cron: "0 9 * * 1-5",
  profile: "",
  prompt: "",
  command: "",
  workdir: "",
  timeout: "",
});

export function schedulePayload(draft: ScheduleDraft): ScheduleInput {
  const base = { name: draft.name.trim(), cron: draft.cron.trim(), kind: draft.kind } as const;
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
