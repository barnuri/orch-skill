import { Controller, Get, Param, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { healthSummaryHandler, readRunHealthHandler } from "../../health/health-route";
import type { RouteHandler } from "../../http/route";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto } from "../../../shared/dto/common";
import { HealthSummaryDto, RunHealthEnvelopeDto } from "../../../shared/dto/run-health";
import { RunIdParamsDto } from "../../../shared/dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunHealthController {
  private readonly health: RouteHandler;
  private readonly summary: RouteHandler;

  constructor(ctx: ServerContext) {
    this.health = readRunHealthHandler(ctx);
    this.summary = healthSummaryHandler(ctx);
  }

  @Get("/health/summary", {
    summary: "Node-health counts",
    description:
      "Stalled, dead, unowned, no-report and ready node counts over the running runs, from the health watcher's in-memory results. Never calls dispatch.sh; a run not yet checked counts as zero. The dashboard header polls it.",
  })
  @ResponseSchema(HealthSummaryDto.schema, { description: "The counts." })
  getHealthSummary(c: ApiContext): Promise<Response> {
    return call(this.summary, c);
  }

  @Get("/runs/{id}/health", {
    summary: "A run's node health",
    description:
      "The latest `dispatch.sh run health <id> --json` result, kept in memory by the server's health watcher (or read from the run's `health:<id>` monitor): a verdict per node (ok, stalled, unowned, dead, no-report), the free slots and the nodes ready to start. Runs one check when nothing is cached yet; `health` is null until a check succeeds. Answers 404 for an unknown run.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunHealthEnvelopeDto.schema, { description: "The latest check." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  getRunHealth(c: ApiContext): Promise<Response> {
    return call(this.health, c);
  }
}
