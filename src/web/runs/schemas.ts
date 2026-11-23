import { z } from "zod";
import type { ChatEnvelope } from "../../shared/types/chat-envelope";
import type { JobLogEnvelope } from "../../shared/types/job-log-envelope";
import type { RunEventsEnvelope } from "../../shared/types/run-event";
import type { RunMessagesEnvelope } from "../../shared/types/run-message";
import type { RunEnvelope } from "../../shared/types/run-envelope";
import type { ActivityEnvelope } from "../lib/owner-activity";
import type { RunsEnvelope } from "../../shared/types/runs-envelope";
import type { HealthSummary, RunHealthEnvelope } from "../../shared/types/run-health";
import type { RunProjection } from "../../../skills/orch/core/runs/projection";
import type { RunOverview } from "../../shared/types/run-overview";
import type { WatchdogStatus } from "../../shared/types/watchdog";

/**
 * Loose objects: the server answers with more fields than the UI reads (and the server's DTO for
 * the job log omits some the shared type carries), so unknown keys must pass through untouched.
 * The shared plain types are the compile-time contract; each schema is narrowed to one.
 */
function typed<T>(schema: unknown): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

export const runsSchema = typed<RunsEnvelope>(
  z.looseObject({ generated_at: z.string(), runs: z.array(z.looseObject({ run_id: z.string(), status: z.string() })) , cache: z.looseObject({ mode: z.string(), source: z.string(), age_ms: z.number() }).optional() }),
);

export const runSchema = typed<RunEnvelope>(
  z.looseObject({
    generated_at: z.string(),
    run: z.looseObject({ run_id: z.string(), nodes: z.array(z.looseObject({ id: z.string() })), edges: z.array(z.tuple([z.string(), z.string()])) }),
    cache: z.looseObject({ mode: z.string(), source: z.string(), age_ms: z.number() }).optional(),
  }),
);

export const jobLogSchema = typed<JobLogEnvelope>(z.looseObject({ text: z.string() }));

export const jobChatSchema = typed<ChatEnvelope>(z.looseObject({ turns: z.array(z.looseObject({ id: z.string() })) }));

export const eventsSchema = typed<RunEventsEnvelope>(
  z.looseObject({ events: z.array(z.looseObject({ n: z.number(), at: z.string(), kind: z.string() })), next: z.number() }),
);

export const runMessagesSchema = typed<RunMessagesEnvelope>(
  z.looseObject({ messages: z.array(z.looseObject({ id: z.string(), seq: z.number(), from: z.string(), to: z.string(), kind: z.string(), text: z.string() })) }),
);

export const nodeActivitySchema = typed<ActivityEnvelope>(
  z.looseObject({ state: z.enum(["ok", "gone", "unknown"]), messages: z.array(z.looseObject({ id: z.string() })), next: z.string().nullable() }),
);

export const runHealthSchema = typed<RunHealthEnvelope>(
  z.looseObject({
    generated_at: z.string(),
    source: z.string(),
    health: z
      .looseObject({
        run: z.string(),
        slots: z.number().nullable(),
        nodes: z.array(z.looseObject({ id: z.string(), health: z.string() })),
        ready: z.array(z.string()),
      })
      .nullable(),
  }),
);

export const healthSummarySchema = typed<HealthSummary>(
  z.looseObject({ running_runs: z.number(), stalled: z.number(), dead: z.number(), unowned: z.number(), no_report: z.number(), needs_user: z.number().optional(), ready: z.number(), flagged_runs: z.array(z.string()),
    herdr: z.looseObject({ state: z.enum(["ok", "degraded", "down", "off"]), problems: z.array(z.string()) }).nullable().optional() }),
);

const watchdogActionSchema = z.looseObject({
  at: z.string(),
  run: z.string(),
  node: z.string().nullable(),
  rule: z.string(),
  action: z.string(),
  detail: z.string(),
  rc: z.number().nullable(),
});

export const watchdogStatusSchema = typed<WatchdogStatus>(
  z.looseObject({
    generated_at: z.string(),
    state: z.enum(["on", "off"]),
    started_at: z.string().nullable(),
    last_actions: z.array(watchdogActionSchema),
    runs: z.record(z.string(), z.looseObject({})),
    flags: z.array(z.looseObject({ run: z.string(), node: z.string(), rule: z.string(), detail: z.string(), at: z.string() })),
    ghosts: z.number().int().nonnegative().default(0),
  }),
);

export const runProjectionSchema = typed<RunProjection>(
  z.looseObject({
    run_id: z.string(),
    status: z.string(),
    raw_status: z.string(),
    counts: z.looseObject({ nodes: z.record(z.string(), z.number()), requirements: z.record(z.string(), z.number()) }),
    nodes: z.array(z.looseObject({ id: z.string(), state: z.string() })),
    requirements: z.array(
      z.looseObject({
        id: z.string(),
        text: z.string(),
        status: z.string(),
        reason: z.string().nullable(),
        ok: z.boolean(),
        bucket: z.string(),
        blocked: z.boolean(),
        nodes: z.array(z.looseObject({ id: z.string(), status: z.string(), done: z.boolean(), handoff: z.boolean(), unverified: z.boolean() })),
        evidence: z.array(z.looseObject({ note: z.string(), file: z.string().nullable(), test: z.string().nullable(), at: z.string() })),
      }),
    ),
    open_requirements: z.array(z.string()),
    partials: z.array(z.string()),
    handoff_gaps: z.array(z.looseObject({ node: z.string() })),
    ready: z.array(z.string()),
    blocked: z.array(z.string()),
    covered: z.array(z.string()),
    skipped: z.array(z.string()),
    run_gate: z.enum(["paused", "stopped"]).nullable(),
    next_actions: z.array(z.looseObject({ kind: z.string(), node: z.string().nullable(), requirement: z.string().nullable(), text: z.string() })),
    owners: z.array(z.looseObject({ node: z.string(), diagnosis: z.string() })),
    supervisor: z.looseObject({ flags: z.array(z.looseObject({ node: z.string(), rule: z.string(), detail: z.string(), at: z.string() })) }),
  }),
);

export const runOverviewSchema = typed<RunOverview>(
  z.looseObject({
    run_id: z.string(),
    title: z.string(),
    nodes: z.array(z.looseObject({ id: z.string(), status: z.string(), skills: z.array(z.string()) })),
    handoffs: z.array(z.looseObject({ id: z.string(), state: z.string() })),
    repos: z.array(z.looseObject({ repo: z.string() })),
    commits: z.array(z.looseObject({ repo: z.string(), sha: z.string() })),
    pull_requests: z.array(z.looseObject({ repo: z.string(), url: z.string() })),
    models: z.array(z.looseObject({ name: z.string(), nodes: z.number() })),
    skills: z.array(z.looseObject({ name: z.string(), nodes: z.number() })),
  }),
);
