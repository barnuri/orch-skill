import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const MODE = z.enum(["message", "fresh"]);
const MONITOR_SPEC = z.object({
  type: z.enum(["file", "url", "command", "stream", "run", "git"]),
  target: z.string().min(1).max(2000),
  condition: z.string().max(40).optional(),
  pattern: z.string().max(300).optional(),
});

@ZodObject({ description: "A chat and one of its schedules, loops or monitors." })
export class ChatItemParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id, `chat-…`." })
  id!: string;

  @ZodField(z.string().min(1).max(100), { description: "Schedule, loop or monitor id." })
  iid!: string;
}

@ZodObject({ description: "A chat, one of its items and what to do to it." })
export class ChatItemActionParamsDto extends ZodDto {
  @ZodField(z.string().min(1).max(100), { description: "Chat id." })
  id!: string;

  @ZodField(z.string().min(1).max(100), { description: "Schedule, loop or monitor id." })
  iid!: string;

  @ZodField(z.enum(["run-now", "pause", "resume", "stop", "log"]), { description: "run-now (schedules and monitors), pause and resume, stop (loops and monitors), log." })
  action!: "run-now" | "pause" | "resume" | "stop" | "log";
}

@ZodObject({ description: "A schedule for this chat. `cron` is the five-field expression; the page turns a phrase such as `every weekday at 9` into it before sending." })
export class ChatScheduleInputDto extends ZodDto {
  @ZodField(z.string().min(1).max(300), { description: "Display name." })
  name!: string;

  @ZodField(z.string().min(1).max(20000), { description: "The prompt that runs." })
  prompt!: string;

  @ZodField(z.string().min(1).max(300), { description: "Cron expression, read in `timezone`. At least 5 minutes between runs." })
  cron!: string;

  @ZodField(z.string().max(100).optional(), { description: "IANA time zone, default the machine's." })
  timezone?: string;

  @ZodField(MODE.optional(), { description: "message (default) continues this chat; fresh runs a new session and posts the answer here." })
  mode?: "message" | "fresh";

  @ZodField(z.boolean().optional(), { description: "False creates it paused." })
  enabled?: boolean;

  @ZodField(z.boolean().optional(), { description: "Run once, then pause." })
  once?: boolean;
}

@ZodObject({ description: "A change to a chat schedule. Omitted fields stay as they are." })
export class ChatSchedulePatchDto extends ZodDto {
  @ZodField(z.string().min(1).max(300).optional(), { description: "Display name." })
  name?: string;

  @ZodField(z.string().min(1).max(20000).optional(), { description: "The prompt." })
  prompt?: string;

  @ZodField(z.string().min(1).max(300).optional(), { description: "Cron expression." })
  cron?: string;

  @ZodField(z.string().max(100).optional(), { description: "IANA time zone." })
  timezone?: string;

  @ZodField(MODE.optional(), { description: "message or fresh." })
  mode?: "message" | "fresh";

  @ZodField(z.boolean().optional(), { description: "Pause (false) or resume (true)." })
  enabled?: boolean;
}

@ZodObject({ description: "A loop that repeats a prompt in this chat." })
export class ChatLoopInputDto extends ZodDto {
  @ZodField(z.string().min(1).max(300), { description: "Display name." })
  label!: string;

  @ZodField(z.string().min(1).max(20000), { description: "The prompt each iteration runs." })
  prompt!: string;

  @ZodField(z.number().int().min(10).max(86400 * 7), { description: "Seconds between iterations (at least 10). `When done` is the minimum." })
  every!: number;

  @ZodField(z.number().int().min(0).max(10000).optional(), { description: "Stop after this many iterations. 0 or absent: no limit." })
  max?: number;

  @ZodField(MODE.optional(), { description: "message or fresh. Both post each iteration into the chat." })
  mode?: "message" | "fresh";

  @ZodField(z.string().max(2000).optional(), { description: "Stop when this command exits 0." })
  until_command?: string;

  @ZodField(z.string().max(300).optional(), { description: "Stop when an iteration's reply matches this regular expression." })
  until_regex?: string;

  @ZodField(z.string().max(500).optional(), { description: "Stop when this is true; the agent judges it." })
  until_text?: string;

  @ZodField(z.number().int().min(60).max(86400 * 7).optional(), { description: "Seconds the loop may run in all." })
  max_runtime?: number;
}

@ZodObject({ description: "A monitor that posts into this chat when something changes or matches." })
export class ChatMonitorInputDto extends ZodDto {
  @ZodField(z.string().min(1).max(300), { description: "Display name." })
  name!: string;

  @ZodField(MONITOR_SPEC, { description: "What to watch: file/folder path, url, command, stream (a command's output), run id or git folder." })
  spec!: { type: "file" | "url" | "command" | "stream" | "run" | "git"; target: string; condition?: string; pattern?: string };

  @ZodField(z.number().int().min(1).max(86400).optional(), { description: "Seconds between checks. At least 10 for local checks, 60 for URLs." })
  every?: number;

  @ZodField(z.boolean().optional(), { description: "Stop after the first trigger." })
  once?: boolean;

  @ZodField(z.number().int().min(0).max(86400).optional(), { description: "Seconds during which more triggers fold into one message." })
  debounce?: number;

  @ZodField(z.number().int().min(60).max(86400 * 7).optional(), { description: "Seconds until it ends by itself. Default 24 hours." })
  expires_in?: number;

  @ZodField(z.object({ mode: z.enum(["tell", "act"]), prompt: z.string().max(20000).optional() }).optional(), { description: "tell posts a message; act also runs this prompt in the chat." })
  then?: { mode: "tell" | "act"; prompt?: string };
}

@ZodObject({ description: "Created." })
export class ChatItemCreatedDto extends ZodDto {
  @ZodField(z.string(), { description: "The new id." })
  id!: string;
}

@ZodObject({ description: "Items of one kind in a chat." })
export class ChatItemsDto extends ZodDto {
  @ZodField(z.array(z.record(z.string(), z.unknown())), { description: "The items, newest first." })
  items!: Array<Record<string, unknown>>;
}

@ZodObject({ description: "The last runs, iterations or triggers of one item." })
export class ChatItemLogDto extends ZodDto {
  @ZodField(z.array(z.object({ at: z.string(), status: z.string(), text: z.string(), message_id: z.string().nullable().optional() })), { description: "Newest first, at most 20." })
  entries!: Array<{ at: string; status: string; text: string; message_id?: string | null }>;
}
