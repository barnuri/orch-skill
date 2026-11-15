export type ScheduleKind = "prompt" | "command";
export type ScheduleRunStatus = "running" | "ok" | "failed" | "lost";

export interface ScheduleRun {
  started_at: string;
  ended_at: string | null;
  kind: ScheduleKind;
  /** A job id for a prompt run, a run directory for a command run. */
  ref: string;
  status: ScheduleRunStatus;
  exit: number | null;
}

/** One schedule, as `dispatch.sh schedule list --json` reports it. Newest run first. */
export interface Schedule {
  id: string;
  name: string;
  cron: string;
  kind: ScheduleKind;
  enabled: boolean;
  created_at: string;
  prompt: string | null;
  profile: string | null;
  command: string | null;
  workdir: string | null;
  /** Seconds a command may run (0 = the default limit). */
  timeout: number;
  /** Epoch seconds of the next run, or null when disabled. */
  next_at: number | null;
  last_run_at: string | null;
  last_status: ScheduleRunStatus | null;
  runs: ScheduleRun[];
}

export interface SchedulesEnvelope {
  generated_at: string;
  schedules: Schedule[];
}

/** The body of POST /api/schedules. */
export interface ScheduleInput {
  name: string;
  cron: string;
  kind: ScheduleKind;
  prompt?: string;
  profile?: string;
  command?: string;
  workdir?: string;
  /** A duration such as 30s, 5m or 1h. */
  timeout?: string;
}
