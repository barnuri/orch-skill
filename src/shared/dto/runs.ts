import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "Which run." })
export class RunIdParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Run id, `YYYYMMDD-HHMMSS-xxxx`." })
  id!: string;
}

@ZodObject({ description: "Which node of which run." })
export class RunNodeParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Run id." })
  id!: string;

  @ZodField(z.string(), { description: "Node id within the run." })
  node!: string;
}

@ZodObject({ description: "Which background job." })
export class JobIdParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Job id." })
  id!: string;
}

@ZodObject({ description: "Which suggestion." })
export class SuggestionIdParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "Suggestion id." })
  id!: string;
}

@ZodObject({ description: "Runs, newest first." })
export class RunsEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this list was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.array(z.record(z.string(), z.unknown())), { description: "Run summaries: id, title, status, node counts, times." })
  runs!: Record<string, unknown>[];
}

@ZodObject({ description: "One run with its plan and every node." })
export class RunEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.record(z.string(), z.unknown()), { description: "The run's state.json, see references/state-and-config.md." })
  run!: Record<string, unknown>;
}

@ZodObject({ description: "Which events to return." })
export class RunEventsQueryDto extends ZodDto {
  @ZodField(z.string().regex(/^\d{1,9}$/).optional(), { description: "Cursor: only events after this number (the `next` of the previous answer). Default 0." })
  after?: string;
}

@ZodObject({ description: "A run's activity feed." })
export class RunEventsEnvelopeDto extends ZodDto {
  @ZodField(z.array(z.record(z.string(), z.unknown())), { description: "Events {n, at, kind, node, from, to, note, by}, oldest first, at most 200 (the newest)." })
  events!: Record<string, unknown>[];

  @ZodField(z.number(), { description: "Cursor for the next call: the number of the newest event." })
  next!: number;
}

@ZodObject({ description: "A job's log." })
export class JobLogEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.string(), { description: "The tail of the job's log." })
  text!: string;
}

@ZodObject({ description: "A job's conversation, for harnesses that keep one." })
export class ChatEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.array(z.record(z.string(), z.unknown())), { description: "The turns, oldest first." })
  turns!: Record<string, unknown>[];
}

@ZodObject({ description: "One harness orch knows of, and whether it can run." })
export class HarnessDto extends ZodDto {
  @ZodField(z.string(), { description: "claude, opencode, copilot, …" })
  id!: string;

  @ZodField(z.enum(["cli", "http"]), { description: "How orch reaches it." })
  kind!: "cli" | "http";

  @ZodField(z.string().nullable(), { description: "The executable, for a CLI." })
  binary!: string | null;

  @ZodField(z.boolean(), { description: "True when orch can dispatch to it. False means only detected." })
  wired!: boolean;

  @ZodField(z.string(), { description: "What it is." })
  description!: string;

  @ZodField(z.array(z.string()), { description: "What it needs to run, e.g. an API key." })
  needs!: string[];

  @ZodField(z.boolean(), { description: "False when listed in settings.disabled_harnesses." })
  enabled!: boolean;

  @ZodField(z.boolean(), { description: "True when the binary or endpoint was found." })
  available!: boolean;

  @ZodField(z.string(), { description: "Why it is unavailable, empty when it is available." })
  reason!: string;
}

@ZodObject({ description: "The harnesses on this machine. Cached for 20 s; `?refresh=1` skips the cache." })
export class HarnessesEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When they were probed, ISO 8601 UTC." })
  probed_at!: string;

  @ZodField([HarnessDto], { description: "Every harness." })
  harnesses!: HarnessDto[];
}

@ZodObject({ description: "Which activity to return." })
export class NodeActivityQueryDto extends ZodDto {
  @ZodField(z.string().max(80).optional(), { description: "Only messages after this message id." })
  after?: string;
}

@ZodObject({ description: "A node owner's recent activity." })
export class NodeActivityEnvelopeDto extends ZodDto {
  @ZodField(z.enum(["ok", "gone", "unknown"]), { description: "`unknown` when opencode is unreachable." })
  state!: "ok" | "gone" | "unknown";

  @ZodField(z.array(z.record(z.string(), z.unknown())), { description: "Messages {id, role, time, parts[{kind, text, tool?}]}, oldest first." })
  messages!: Record<string, unknown>[];

  @ZodField(z.string().nullable(), { description: "Cursor for `after`: the newest message id." })
  next!: string | null;
}

@ZodObject({ description: "A message from the user to one node." })
export class NodeMessageInputDto extends ZodDto {
  @ZodField(z.string().trim().min(1).max(16000), { description: "The message text." })
  text!: string;

  @ZodField(z.string().regex(/^m\d{1,9}$/).optional(), { description: "Answer only: the ask id (e.g. `m3`). Default: the node's oldest open ask." })
  ask?: string;
}

@ZodObject({ description: "The coordinator pane the user picked from the candidates." })
export class RepointInputDto extends ZodDto {
  @ZodField(z.string().min(1).max(500), { description: "Herdr socket path of the candidate." })
  socket_path!: string;

  @ZodField(z.string().min(1).max(100), { description: "Pane id of the candidate." })
  pane_id!: string;
}

@ZodObject({ description: "A run's messages, oldest first." })
export class RunMessagesEnvelopeDto extends ZodDto {
  @ZodField(z.array(z.record(z.string(), z.unknown())), { description: "Messages {id, seq, from, to, kind (tell|ask|answer|rule), at, text, status, delivered_at, via, answer?, answered_at?, reply_to?}." })
  messages!: Record<string, unknown>[];
}
