import { Controller, Get, Param, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import { readQualityHandler } from "../../runs/quality-route";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto } from "../../../shared/dto/common";
import { RunQualityEnvelopeDto } from "../../../shared/dto/quality";
import { RunIdParamsDto } from "../../../shared/dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunQualityController {
  private readonly handler: RouteHandler;

  constructor(ctx: ServerContext) {
    this.handler = readQualityHandler(ctx);
  }

  @Get("/runs/{id}/quality", {
    summary: "A run's quality reports",
    description:
      "The quality reports written by `dispatch.ts node quality append`: per node and stage, the model requested and actually run, the verdict, score, confidence, findings with severity, category, evidence, file and line, the reviewer model, timestamps and the raw source artifact path. Read only. An empty list when the run has none. Answers 404 for an unknown run.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunQualityEnvelopeDto.schema, { description: "The reports." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  getRunQuality(c: ApiContext): Promise<Response> {
    return call(this.handler, c);
  }
}
