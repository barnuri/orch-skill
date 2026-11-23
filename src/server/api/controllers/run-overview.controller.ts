import { Controller, Get, Param, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import { readRunOverviewHandler, readRunOverviewHtmlHandler } from "../../runs/overview-route";
import type { ServerContext } from "../../types/server-context";
import { ErrorDto } from "../../../shared/dto/common";
import { RunOverviewDto } from "../../../shared/dto/run-overview";
import { RunIdParamsDto } from "../../../shared/dto/runs";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class RunOverviewController {
  private readonly overview: RouteHandler;
  private readonly html: RouteHandler;

  constructor(ctx: ServerContext) {
    this.overview = readRunOverviewHandler(ctx);
    this.html = readRunOverviewHtmlHandler(ctx);
  }

  @Get("/runs/{id}/overview", {
    summary: "A run's overview",
    description:
      "The overview of one run, built by `dispatch.ts run overview <run> --json` (the same data as `<run>/overview.html`): repos, commits, pull requests, models, skills, nodes and handoff evidence. Takes a few seconds when gh checks pull requests. Answers 404 for an unknown run and 502 when dispatch fails.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(RunOverviewDto.schema, { description: "The overview." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  @ResponseSchema(ErrorDto.schema, { status: 502, description: "dispatch.ts did not return the overview." })
  getRunOverview(c: ApiContext): Promise<Response> {
    return call(this.overview, c);
  }

  @Get("/runs/{id}/overview.html", {
    summary: "A run's overview page",
    description:
      "The page `<run>/overview.html`. Regenerated when it is missing or older than the run state, otherwise served as is. Answers 404 for an unknown run.",
  })
  @Param(RunIdParamsDto.schema)
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such run." })
  getRunOverviewHtml(c: ApiContext): Promise<Response> {
    return call(this.html, c);
  }
}
