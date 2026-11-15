import { z } from "zod";
import type { ChatEnvelope } from "../../shared/types/chat-envelope";
import type { JobLogEnvelope } from "../../shared/types/job-log-envelope";
import type { RunEventsEnvelope } from "../../shared/types/run-event";
import type { RunEnvelope } from "../../shared/types/run-envelope";
import type { ActivityEnvelope } from "../lib/owner-activity";
import type { RunsEnvelope } from "../../shared/types/runs-envelope";

/**
 * Loose objects: the server answers with more fields than the UI reads (and the server's DTO for
 * the job log omits some the shared type carries), so unknown keys must pass through untouched.
 * The shared plain types are the compile-time contract; each schema is narrowed to one.
 */
function typed<T>(schema: unknown): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

export const runsSchema = typed<RunsEnvelope>(
  z.looseObject({ generated_at: z.string(), runs: z.array(z.looseObject({ run_id: z.string(), status: z.string() })) }),
);

export const runSchema = typed<RunEnvelope>(
  z.looseObject({
    generated_at: z.string(),
    run: z.looseObject({ run_id: z.string(), nodes: z.array(z.looseObject({ id: z.string() })), edges: z.array(z.tuple([z.string(), z.string()])) }),
  }),
);

export const jobLogSchema = typed<JobLogEnvelope>(z.looseObject({ text: z.string() }));

export const jobChatSchema = typed<ChatEnvelope>(z.looseObject({ turns: z.array(z.looseObject({ id: z.string() })) }));

export const eventsSchema = typed<RunEventsEnvelope>(
  z.looseObject({ events: z.array(z.looseObject({ n: z.number(), at: z.string(), kind: z.string() })), next: z.number() }),
);

export const nodeActivitySchema = typed<ActivityEnvelope>(
  z.looseObject({ state: z.enum(["ok", "gone", "unknown"]), messages: z.array(z.looseObject({ id: z.string() })), next: z.string().nullable() }),
);
