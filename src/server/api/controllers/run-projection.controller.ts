import { Controller, Get, Param, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import { readRunProjectionHandler } from "../../runs/projection-route";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto } from "../../../shared/dto/common";
import { RunProjectionDto } from "../../../shared/dto/run-projection";
import { RunIdParamsDto } from "../../../shared/dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunProjectionController {
  private readonly handler: RouteHandler;

  constructor(ctx: ServerContext) {
    this.handler = readRunProjectionHandler(ctx);
  }

  @Get("/runs/{id}/projection", {
    summary: "A run's canonical projection",
    description:
      "The one computed state of a run, from its state.json, requirements.json, the nodes' handoff.md files and the watchdog flags: effective status, node and requirement counts, open requirements, partials, handoff gaps, blocked, covered and skipped nodes, ready nodes, next actions, owner diagnostics and supervisor flags. `run status --json` prints the same object under `projection`. Answers 404 for an unknown run.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunProjectionDto.schema, { description: "The projection." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  getRunProjection(c: ApiContext): Promise<Response> {
    return call(this.handler, c);
  }
}
