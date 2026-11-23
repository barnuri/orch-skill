import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const RULES = ["lost", "stalled", "unverified", "infra-retry", "cli-source", "starting", "finish", "coordinator"] as const;

@ZodObject({ description: "One watchdog action, as one line of `<home>/watchdog/actions.log`." })
export class WatchdogActionDto extends ZodDto {
  @ZodField(z.string(), { description: "When, ISO 8601 UTC." })
  at!: string;

  @ZodField(z.string(), { description: "Run id." })
  run!: string;

  @ZodField(z.string().nullable(), { description: "Node id; null for a run-level action." })
  node!: string | null;

  @ZodField(z.enum(RULES), {
    description: "`lost`: the node's process or session was dead for 2 minutes; `stalled`: idle past stall_minutes; `unverified`: done without handoff.md; `infra-retry`: an infrastructure error; `finish`: every node is done.",
  })
  rule!: (typeof RULES)[number];

  @ZodField(z.string(), { description: "The dispatch.ts call (`node retry`, `node update error`, `run finish`), or `flag` when the watchdog only reports." })
  action!: string;

  @ZodField(z.string(), { description: "Why, in words." })
  detail!: string;

  @ZodField(z.number().nullable(), { description: "dispatch.ts exit code; null for a flag." })
  rc!: number | null;
}

@ZodObject({ description: "Per-run action counts." })
export class WatchdogCountersDto extends ZodDto {
  @ZodField(z.number(), { description: "Nodes marked lost." })
  lost!: number;

  @ZodField(z.number(), { description: "Stalled reports." })
  stalled!: number;

  @ZodField(z.number(), { description: "Done nodes re-queued for a missing handoff." })
  unverified!: number;

  @ZodField(z.number(), { description: "CLI and source errors routed to the orchestrator." })
  cli_source!: number;

  @ZodField(z.number(), { description: "Automatic retries." })
  retried!: number;

  @ZodField(z.number(), { description: "Nodes flagged after their one retry." })
  flagged!: number;

  @ZodField(z.number(), { description: "Runs finished." })
  finished!: number;
}

@ZodObject({ description: "A node the watchdog reports and does not act on." })
export class WatchdogFlagDto extends ZodDto {
  @ZodField(z.string(), { description: "Run id." })
  run!: string;

  @ZodField(z.string(), { description: "Node id." })
  node!: string;

  @ZodField(z.enum(RULES), { description: "The rule that flagged it." })
  rule!: (typeof RULES)[number];

  @ZodField(z.string(), { description: "Why, in words." })
  detail!: string;

  @ZodField(z.string(), { description: "When, ISO 8601 UTC." })
  at!: string;
}

@ZodObject({ description: "The server's watchdog: its state, newest actions first, per-run counters and open flags." })
export class WatchdogStatusDto extends ZodDto {
  @ZodField(z.string(), { description: "When this answer was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.enum(["on", "off"]), { description: "`on`: the watchdog runs in this server; `off`: it was not started." })
  state!: "on" | "off";

  @ZodField(z.string().nullable(), { description: "When the watchdog started, ISO 8601 UTC." })
  started_at!: string | null;

  @ZodField([WatchdogActionDto], { description: "The last 50 actions, newest first." })
  last_actions!: WatchdogActionDto[];

  @ZodField(z.record(z.string(), WatchdogCountersDto.schema), { description: "Action counts per run id." })
  runs!: Record<string, WatchdogCountersDto>;

  @ZodField([WatchdogFlagDto], { description: "Open flags on running runs: stalled nodes and nodes out of retries." })
  flags!: WatchdogFlagDto[];
}
