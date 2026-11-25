export type ScheduleKind = "prompt" | "command";
export type ScheduleRunStatus = "running" | "ok" | "failed" | "lost" | "skipped";

export interface ScheduleRun {
  started_at: string;
  ended_at: string | null;
  kind: ScheduleKind | "chat";
  /** A job id for a prompt run, a run directory for a command run. */
  ref: string;
  status: ScheduleRunStatus;
  exit: number | null;
  /** Catalog model id a prompt run used; null or absent = the profile's default. */
  model?: string | null;
  /** Chat schedules: the posted message, how long it took and what went wrong. */
  message_id?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  note?: string | null;
}

/** One schedule, as `dispatch.ts schedule list --json` reports it. Newest run first. */
export interface Schedule {
  id: string;
  name: string;
  /** Optional note on what the schedule is for; null or absent when none. */
  description?: string | null;
  cron: string;
  kind: ScheduleKind;
  enabled: boolean;
  /** No notification for this schedule's runs; absent means false. */
  muted?: boolean;
  created_at: string;
  /** When it was last edited; absent until the first edit. */
  updated_at?: string | null;
  prompt: string | null;
  profile: string | null;
  /** Catalog model id the prompt runs on; null or absent = the profile's default. */
  model?: string | null;
  command: string | null;
  workdir: string | null;
  /** Seconds a command may run (0 = the default limit). */
  timeout: number;
  /** Epoch seconds of the next run, or null when disabled. */
  next_at: number | null;
  last_run_at: string | null;
  last_status: ScheduleRunStatus | null;
  runs: ScheduleRun[];
  /** Set for a schedule whose result returns to a chat. */
  target?: { kind: "chat"; chat_id: string; mode: "message" | "fresh" };
  /** IANA zone the cron is read in (chat schedules); absent means the machine's zone. */
  timezone?: string;
  once?: boolean;
  consecutive_failures?: number;
  retry_at?: number | null;
  pause_reason?: string | null;
}

export interface SchedulesEnvelope {
  generated_at: string;
  schedules: Schedule[];
}

/** The body of POST /api/schedules. */
export interface ScheduleInput {
  name: string;
  /** Optional note on what the schedule is for. On edit, "" clears it. */
  description?: string;
  cron: string;
  kind: ScheduleKind;
  prompt?: string;
  profile?: string;
  /** Catalog model id; null or absent = the profile's default. */
  model?: string | null;
  command?: string;
  workdir?: string;
  /** A duration such as 30s, 5m or 1h. */
  timeout?: string;
}

/** The body of PUT /api/schedules/{id}. Omitted fields stay as they are. */
export type ScheduleEdit = Partial<ScheduleInput>;
