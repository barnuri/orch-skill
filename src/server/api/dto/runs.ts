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
