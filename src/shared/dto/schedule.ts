import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const STATUS = z.enum(["running", "ok", "failed", "lost", "skipped"]);
const KIND = z.enum(["prompt", "command"]);
const RUN_KIND = z.enum(["prompt", "command", "chat"]);

@ZodObject({ description: "One run of a schedule." })
export class ScheduleRunDto extends ZodDto {
  @ZodField(z.string(), { description: "When the run started, ISO 8601 UTC." })
  started_at!: string;

  @ZodField(z.string().nullable(), { description: "When it ended, taken from its exit marker. Null while running." })
  ended_at!: string | null;

  @ZodField(RUN_KIND, { description: "Whether this run was a prompt, a command or a prompt posted into a chat." })
  kind!: "prompt" | "command" | "chat";

  @ZodField(z.string(), { description: "A job id for a prompt run, a run directory for a command run." })
  ref!: string;

  @ZodField(STATUS, { description: "running until an exit marker exists; lost when the process vanished without one." })
  status!: "running" | "ok" | "failed" | "lost";

  @ZodField(z.number().int().nullable(), { description: "Exit code of a command run. Null for a prompt run or while running." })
  exit!: number | null;

  @ZodField(z.string().nullable().optional(), { description: "Catalog model id a prompt run used. Null or absent: the profile's default model." })
  model?: string | null;

  @ZodField(z.string().nullable().optional(), { description: "Chat schedules: id of the message the run posted." })
  message_id?: string | null;

  @ZodField(z.number().nullable().optional(), { description: "Chat schedules: how long the run took, in ms." })
  duration_ms?: number | null;

  @ZodField(z.string().nullable().optional(), { description: "Chat schedules: why the run failed." })
  error?: string | null;

  @ZodField(z.string().nullable().optional(), { description: "Chat schedules: a note, e.g. a missed run that was skipped." })
  note?: string | null;
}

@ZodObject({ description: "A cron schedule that runs a prompt or a shell command." })
export class ScheduleDto extends ZodDto {
  @ZodField(z.string(), { description: "Id, sch-<date>-<time>-<hex>." })
  id!: string;

  @ZodField(z.string(), { description: "Display name." })
  name!: string;

  @ZodField(z.string().nullable().optional(), { description: "What the schedule is for. Null or absent when none." })
  description?: string | null;

  @ZodField(z.string(), { description: "Five-field cron expression or an @alias, in the machine's local time." })
  cron!: string;

  @ZodField(KIND, { description: "What a run does." })
  kind!: "prompt" | "command";

  @ZodField(z.boolean(), { description: "A paused schedule never fires." })
  enabled!: boolean;

  @ZodField(z.boolean().optional(), { description: "A muted schedule sends no notification (orch, push, Herdr, Telegram). Absent means false." })
  muted?: boolean;

  @ZodField(z.string(), { description: "When it was created, ISO 8601 UTC." })
  created_at!: string;

  @ZodField(z.string().nullable().optional(), { description: "When it was last edited, ISO 8601 UTC. Absent until the first edit." })
  updated_at?: string | null;

  @ZodField(z.string().nullable(), { description: "The prompt text, for a prompt schedule." })
  prompt!: string | null;

  @ZodField(z.string().nullable(), { description: "The profile that runs the prompt." })
  profile!: string | null;

  @ZodField(z.string().nullable().optional(), { description: "Catalog model id the prompt runs on. Null or absent: the profile's default model." })
  model?: string | null;

  @ZodField(z.string().nullable(), { description: "The shell command, for a command schedule." })
  command!: string | null;

  @ZodField(z.string().nullable(), { description: "Directory the command runs in." })
  workdir!: string | null;

  @ZodField(z.number().int(), { description: "Seconds a command may run. 0 means the default limit (1 h)." })
  timeout!: number;

  @ZodField(z.number().nullable(), { description: "Epoch seconds of the next run. Null when paused." })
  next_at!: number | null;

  @ZodField(z.string().nullable(), { description: "When it last started, ISO 8601 UTC." })
  last_run_at!: string | null;

  @ZodField(STATUS.nullable(), { description: "Status of the newest run. Null when it never ran." })
  last_status!: "running" | "ok" | "failed" | "lost" | null;

  @ZodField([ScheduleRunDto], { description: "The newest 30 runs, newest first." })
  runs!: ScheduleRunDto[];

  @ZodField(z.object({ kind: z.literal("chat"), chat_id: z.string(), mode: z.enum(["message", "fresh"]) }).optional(), { description: "Set when the result returns to a chat." })
  target?: { kind: "chat"; chat_id: string; mode: "message" | "fresh" };

  @ZodField(z.string().optional(), { description: "IANA time zone of a chat schedule's cron." })
  timezone?: string;

  @ZodField(z.string().nullable().optional(), { description: "Why a chat schedule paused itself." })
  pause_reason?: string | null;
}

@ZodObject({ description: "Every schedule, newest first." })
export class SchedulesEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this list was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField([ScheduleDto], { description: "The schedules." })
  schedules!: ScheduleDto[];
}

@ZodObject({ description: "A new schedule. A prompt schedule needs `prompt` and `profile`; a command schedule needs `command`." })
export class ScheduleInputDto extends ZodDto {
  @ZodField(z.string().min(1).max(300), { description: "Display name." })
  name!: string;

  @ZodField(z.string().max(1000).optional(), { description: "What the schedule is for. Optional." })
  description?: string;

  @ZodField(z.string().min(1).max(300), { description: "Cron expression, e.g. `0 9 * * 1-5`. Check one with GET /api/schedules/preview." })
  cron!: string;

  @ZodField(KIND, { description: "What each run does." })
  kind!: "prompt" | "command";

  @ZodField(z.string().max(20000).optional(), { description: "The prompt, for kind=prompt." })
  prompt?: string;

  @ZodField(z.string().max(300).optional(), { description: "The profile that runs the prompt, for kind=prompt." })
  profile?: string;

  @ZodField(z.string().max(300).nullable().optional(), { description: "Catalog model id the prompt runs on, one the profile allows (GET /api/chat-options). Null or absent: the profile's default." })
  model?: string | null;

  @ZodField(z.string().max(20000).optional(), { description: "The shell command, for kind=command." })
  command?: string;

  @ZodField(z.string().max(300).optional(), { description: "Working directory, for kind=command." })
  workdir?: string;

  @ZodField(z.string().max(10).optional(), { description: "Time limit such as 30s, 5m or 1h, for kind=command." })
  timeout?: string;
}

@ZodObject({
  description:
    "A change to a schedule. Omitted fields stay as they are. `kind` switches between a prompt and a command schedule and clears the other kind's fields; a switch needs the new kind's fields. An empty `workdir` and a `timeout` of 0 clear those.",
})
export class ScheduleEditDto extends ZodDto {
  @ZodField(z.string().min(1).max(300).optional(), { description: "Display name." })
  name?: string;

  @ZodField(z.string().max(1000).optional(), { description: "What the schedule is for. Empty clears it." })
  description?: string;

  @ZodField(z.string().min(1).max(300).optional(), { description: "Cron expression. Check one with GET /api/schedules/preview." })
  cron?: string;

  @ZodField(KIND.optional(), { description: "What each run does. Omit to keep the current kind." })
  kind?: "prompt" | "command";

  @ZodField(z.string().min(1).max(20000).optional(), { description: "The prompt, for kind=prompt." })
  prompt?: string;

  @ZodField(z.string().min(1).max(300).optional(), { description: "The profile that runs the prompt, for kind=prompt." })
  profile?: string;

  @ZodField(z.string().max(300).nullable().optional(), { description: "Catalog model id for kind=prompt. Null goes back to the profile's default; omitted keeps it (a profile change drops a model the new profile does not allow)." })
  model?: string | null;

  @ZodField(z.string().min(1).max(20000).optional(), { description: "The shell command, for kind=command." })
  command?: string;

  @ZodField(z.string().max(300).optional(), { description: "Working directory, for kind=command. Empty clears it." })
  workdir?: string;

  @ZodField(z.string().max(10).optional(), { description: "Time limit such as 30s, 5m or 1h, for kind=command. 0 means the default (1 h)." })
  timeout?: string;
}

@ZodObject({ description: "A schedule was created." })
export class ScheduleCreatedDto extends ZodDto {
  @ZodField(z.boolean(), { description: "Always true." })
  ok!: boolean;

  @ZodField(z.string(), { description: "The new schedule's id." })
  id!: string;
}

@ZodObject({ description: "The cron expression to check." })
export class SchedulePreviewQueryDto extends ZodDto {
  @ZodField(z.string().min(1).max(300), { description: "Cron expression, five fields or an @alias." })
  cron!: string;
}

@ZodObject({ description: "The next time a cron expression fires." })
export class SchedulePreviewDto extends ZodDto {
  @ZodField(z.string(), { description: "Local time of the next run, `YYYY-MM-DD HH:MM`." })
  next!: string;
}

@ZodObject({ description: "A run's output." })
export class ScheduleLogDto extends ZodDto {
  @ZodField(z.string(), { description: "The last 64 KB of the run's output." })
  text!: string;
}

@ZodObject({ description: "Which schedule." })
export class ScheduleIdParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Schedule id, `sch-YYYYMMDD-HHMMSS-xxxx`." })
  id!: string;
}

@ZodObject({ description: "Which schedule and what to do to it." })
export class ScheduleActionParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Schedule id." })
  id!: string;

  @ZodField(z.string(), { description: "run, enable, disable, mute, unmute or remove." })
  action!: string;
}

@ZodObject({ description: "Which run of which schedule." })
export class ScheduleRunParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Schedule id." })
  id!: string;

  @ZodField(z.string(), { description: "Run index, 0 for the newest." })
  index!: string;
}
