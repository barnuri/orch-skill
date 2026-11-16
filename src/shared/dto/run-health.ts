import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "One node's health verdict." })
export class NodeHealthDto extends ZodDto {
  @ZodField(z.string(), { description: "Node id." })
  id!: string;

  @ZodField(z.string(), { description: "The node's status in state.json." })
  status!: string;

  @ZodField(z.enum(["ok", "stalled", "unowned", "dead", "no-report", "needs-user", "held"]), {
    description: "`stalled`: no activity for the stale limit; `unowned`: no owner recorded; `dead`: the owner is gone; `no-report`: the owner ended without reporting; `needs-user`: a waiting node blocked on the user; `held`: a waiting node the coordinator holds back (`node update --hold`).",
  })
  health!: "ok" | "stalled" | "unowned" | "dead" | "no-report" | "needs-user" | "held";

  @ZodField(z.string().nullable(), { description: "The owning session or job id, null when there is none." })
  owner_id!: string | null;

  @ZodField(z.string().nullable(), { description: "Newest activity seen, ISO 8601 UTC." })
  last_activity!: string | null;

  @ZodField(z.number().nullable(), { description: "Minutes since the last activity." })
  idle_min!: number | null;

  @ZodField(z.string().nullable(), { description: "A short human note." })
  note!: string | null;
}

@ZodObject({ description: "The output of `dispatch.ts run health <id> --json`." })
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

@ZodObject({ description: "The orch skill's own herdr instance and its herdr web env (`dispatch.ts herdr health --json`)." })
export class HerdrHealthDto extends ZodDto {
  @ZodField(z.enum(["ok", "degraded", "down", "off"]), {
    description: "`ok`; `degraded`: up, but its herdr web registry file is missing or wrong, or herdr web does not list it; `down`: the instance does not answer; `off`: herdr is disabled.",
  })
  state!: "ok" | "degraded" | "down" | "off";

  @ZodField(z.boolean(), { description: "Whether orch runs jobs in herdr at all." })
  enabled!: boolean;

  @ZodField(z.string(), { description: "Why herdr is on or off." })
  reason!: string;

  @ZodField(z.string(), { description: "The herdr web environment id, `orch-skill`." })
  env_id!: string;

  @ZodField(z.number().nullable(), { description: "The server pid from its pidfile." })
  pid!: number | null;

  @ZodField(z.boolean(), { description: "The pidfile's process is a live herdr." })
  pid_alive!: boolean;

  @ZodField(z.boolean(), { description: "The instance answers on its socket." })
  socket_ok!: boolean;

  @ZodField(z.string(), { description: "The herdr web registry file: `ok`, `missing` or `wrong`." })
  registry!: string;

  @ZodField(z.string(), { description: "Path of the registry file." })
  registry_path!: string;

  @ZodField(z.string(), { description: "What herdr web lists: `listed`, `unreachable`, `missing`, `no-plugin` or `skipped`." })
  web!: string;

  @ZodField(z.string(), { description: "The herdr web plugin URL that was asked." })
  web_url!: string;

  @ZodField(z.boolean(), { description: "This check re-ensured the instance or its registry." })
  nudged!: boolean;

  @ZodField(z.string(), { description: "When the check ran, ISO 8601 UTC." })
  at!: string;

  @ZodField(z.array(z.string()), { description: "What is wrong, in words." })
  problems!: string[];
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

  @ZodField(HerdrHealthDto.schema.nullable().optional(), { description: "The orch herdr instance's latest check; null before the first one." })
  herdr?: HerdrHealthDto | null;
}
