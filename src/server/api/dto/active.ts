import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "A running loop or monitor, or one that failed or lost its process." })
export class ActiveItemDto extends ZodDto {
  @ZodField(z.enum(["loop", "watch"]), { description: "loop repeats a prompt; watch runs a monitor command." })
  kind!: "loop" | "watch";

  @ZodField(z.string(), { description: "Id, loop-… or watch-…" })
  id!: string;

  @ZodField(z.string(), { description: "Display name." })
  name!: string;

  @ZodField(z.enum(["running", "failed", "lost"]), { description: "lost means the recorded process no longer exists." })
  status!: "running" | "failed" | "lost";

  @ZodField(z.string().nullable(), { description: "Why it stopped, when it did." })
  reason!: string | null;

  @ZodField(z.string(), { description: "When it started, ISO 8601 UTC." })
  started!: string;

  @ZodField(z.number(), { description: "Seconds between ticks or reruns. 0 for a streaming monitor." })
  interval!: number;

  @ZodField(z.number(), { description: "Epoch seconds when it stops by itself." })
  deadline!: number;

  @ZodField(z.number().optional(), { description: "Loop: completed iterations." })
  iteration?: number;

  @ZodField(z.number().optional(), { description: "Loop: iteration limit, 0 for none." })
  max?: number;

  @ZodField(z.number().optional(), { description: "Loop: epoch seconds of the next tick." })
  next?: number;

  @ZodField(z.number().nullable().optional(), { description: "Loop: exit code of the last iteration." })
  last_exit?: number | null;

  @ZodField(z.string().optional(), { description: "Loop: fresh, resume or id." })
  session?: string;

  @ZodField(z.number().optional(), { description: "Loop: ticks skipped because the session was busy." })
  skipped?: number;

  @ZodField(z.boolean().optional(), { description: "Loop: waits for an idle session before each tick." })
  when_idle?: boolean;

  @ZodField(z.number().optional(), { description: "Monitor: events captured." })
  events?: number;

  @ZodField(z.string().nullable().optional(), { description: "Monitor: when the last event arrived." })
  last_event?: string | null;

  @ZodField(z.string().optional(), { description: "Monitor: the command it runs." })
  cmd?: string;
}

@ZodObject({ description: "Running loops and monitors." })
export class ActiveEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this list was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField([ActiveItemDto], { description: "The items." })
  items!: ActiveItemDto[];
}

@ZodObject({ description: "Which loop or monitor." })
export class ActiveIdParamsDto extends ZodDto {
  @ZodField(z.string(), { description: "loop-YYYYMMDD-HHMMSS-xxxx or watch-YYYYMMDD-HHMMSS-xxxx." })
  id!: string;
}
