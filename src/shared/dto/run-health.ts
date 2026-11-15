import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "One node's health verdict." })
export class NodeHealthDto extends ZodDto {
  @ZodField(z.string(), { description: "Node id." })
  id!: string;

  @ZodField(z.string(), { description: "The node's status in state.json." })
  status!: string;

  @ZodField(z.enum(["ok", "stalled", "unowned", "dead", "no-report", "needs-user"]), {
    description: "`stalled`: no activity for the stale limit; `unowned`: no owner recorded; `dead`: the owner is gone; `no-report`: the owner ended without reporting; `needs-user`: a waiting node blocked on the user.",
  })
  health!: "ok" | "stalled" | "unowned" | "dead" | "no-report" | "needs-user";

  @ZodField(z.string().nullable(), { description: "The owning session or job id, null when there is none." })
  owner_id!: string | null;

  @ZodField(z.string().nullable(), { description: "Newest activity seen, ISO 8601 UTC." })
  last_activity!: string | null;

  @ZodField(z.number().nullable(), { description: "Minutes since the last activity." })
  idle_min!: number | null;

  @ZodField(z.string().nullable(), { description: "A short human note." })
  note!: string | null;
}

@ZodObject({ description: "The output of `dispatch.sh run health <id> --json`." })
export class RunHealthDto extends ZodDto {
  @ZodField(z.string(), { description: "Run id." })
  run!: string;

  @ZodField(z.string(), { description: "When the check ran, ISO 8601 UTC." })
  at!: string;

  @ZodField(z.number(), { description: "settings.max_parallel." })
  max_parallel!: number;

  @ZodField(z.number(), { description: "Nodes running now." })
  running!: number;

  @ZodField(z.number(), { description: "Free slots: max_parallel minus running." })
  slots!: number;

  @ZodField([NodeHealthDto], { description: "Every node with its verdict." })
  nodes!: NodeHealthDto[];

  @ZodField(z.array(z.string()), { description: "Waiting nodes whose dependencies are done, ready to start." })
  ready!: string[];

  @ZodField(z.array(z.unknown()), { description: "What changed since the previous check." })
  changes!: unknown[];
}

@ZodObject({ description: "A run's latest health check." })
export class RunHealthEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When this answer was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.enum(["watcher", "monitor", "none"]), {
    description: "`monitor`: read from the run's `health:<id>` monitor; `watcher`: the server's own pass; `none`: no result yet.",
  })
  source!: "watcher" | "monitor" | "none";

  @ZodField(RunHealthDto.schema.nullable(), { description: "The check, null until one has succeeded." })
  health!: RunHealthDto | null;
}

@ZodObject({ description: "Node-health counts over the running runs, from the server's in-memory checks." })
export class HealthSummaryDto extends ZodDto {
  @ZodField(z.string(), { description: "When this answer was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.number(), { description: "Runs with status running." })
  running_runs!: number;

  @ZodField(z.number(), { description: "Stalled nodes." })
  stalled!: number;

  @ZodField(z.number(), { description: "Nodes whose owner is gone." })
  dead!: number;

  @ZodField(z.number(), { description: "Running nodes with no owner." })
  unowned!: number;

  @ZodField(z.number(), { description: "Nodes whose owner ended without a report." })
  no_report!: number;

  @ZodField(z.number(), { description: "Waiting nodes blocked on the user." })
  needs_user!: number;

  @ZodField(z.number(), { description: "Nodes ready to start in runs with a free slot." })
  ready!: number;

  @ZodField(z.array(z.string()), { description: "Running runs with at least one node that is not ok." })
  flagged_runs!: string[];
}
