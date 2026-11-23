import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

/** The run projection. The type is `RunProjection` in skills/orch/core/runs/projection.ts, the single source; this DTO documents the wire shape. */
@ZodObject({ description: "A run's canonical projection: effective status, counts, requirements, readiness, next actions, owners and supervisor flags." })
export class RunProjectionDto extends ZodDto {
  @ZodField(z.string(), { description: "Run id." })
  run_id!: string;

  @ZodField(z.string(), { description: "Effective status: `stopped` or `paused` when set, else the run status." })
  status!: string;

  @ZodField(z.string(), { description: "The run's own status in state.json." })
  raw_status!: string;

  @ZodField(z.object({ nodes: z.record(z.string(), z.number()), requirements: z.record(z.string(), z.number()) }), { description: "Node counts by state and requirement counts by bucket." })
  counts!: { nodes: Record<string, number>; requirements: Record<string, number> };

  @ZodField(z.array(z.unknown()), { description: "Every node with its state, blocked_by, hold, needs_user, handoff, result and unverified." })
  nodes!: unknown[];

  @ZodField(z.array(z.unknown()), { description: "Every requirement with bucket, ok, blocked, linked nodes and evidence." })
  requirements!: unknown[];

  @ZodField(z.array(z.string()), { description: "Ids of open requirements." })
  open_requirements!: string[];

  @ZodField(z.array(z.string()), { description: "Ids of partial requirements." })
  partials!: string[];

  @ZodField(z.array(z.unknown()), { description: "Done nodes with no handoff.md." })
  handoff_gaps!: unknown[];

  @ZodField(z.array(z.string()), { description: "Waiting nodes whose dependencies are met, ready to start. Empty while the run is paused or stopped." })
  ready!: string[];

  @ZodField(z.array(z.string()), { description: "Nodes blocked by a dependency, a hold or a question." })
  blocked!: string[];

  @ZodField(z.array(z.string()), { description: "Nodes covered by a replacement." })
  covered!: string[];

  @ZodField(z.array(z.string()), { description: "Nodes skipped." })
  skipped!: string[];

  @ZodField(z.enum(["paused", "stopped"]).nullable(), { description: "The run gate that stops every start, or null." })
  run_gate!: "paused" | "stopped" | null;

  @ZodField(z.array(z.unknown()), { description: "What to do next, in priority order." })
  next_actions!: unknown[];

  @ZodField(z.array(z.unknown()), { description: "Running nodes with their owner state and diagnosis." })
  owners!: unknown[];

  @ZodField(z.object({ flags: z.array(z.unknown()) }), { description: "Watchdog flags that still stand for this run." })
  supervisor!: { flags: unknown[] };
}
