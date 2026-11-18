import { Controller, Get, Param, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import { readRequirementsHandler } from "../../runs/requirements-route";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto } from "../../../shared/dto/common";
import { RunRequirementsEnvelopeDto } from "../../../shared/dto/run-health";
import { RunIdParamsDto } from "../../../shared/dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunRequirementsController {
  private readonly handler: RouteHandler;

  constructor(ctx: ServerContext) {
    this.handler = readRequirementsHandler(ctx);
  }

  @Get("/runs/{id}/requirements", {
    summary: "A run's requirements ledger",
    description:
      "The ledger `<run>/requirements.json` (written only by `dispatch.ts req *`): each requirement with its status, evidence and linked nodes, and for each node whether it is done, has a non-empty handoff and is unverified. An empty list when the run has no ledger. Answers 404 for an unknown run.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunRequirementsEnvelopeDto.schema, { description: "The ledger." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  getRunRequirements(c: ApiContext): Promise<Response> {
    return call(this.handler, c);
  }
}
