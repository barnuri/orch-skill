import { Controller, Get, Param, Post, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { listActiveHandler, stopActiveHandler } from "../../routes/active-routes";
import type { RouteHandler } from "../../http/route";
import type { ServerContext } from "../../types/server-context";
import { ActiveEnvelopeDto, ActiveIdParamsDto } from "../../../shared/dto/active";
import { ErrorDto, OkDto } from "../../../shared/dto/common";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["loops"] })
export class ActiveController {
  private readonly list: RouteHandler;
  private readonly stop: RouteHandler;

  constructor(ctx: ServerContext) {
    this.list = listActiveHandler(ctx);
    this.stop = stopActiveHandler(ctx);
  }

  @Get("/active", {
    summary: "Running loops and monitors",
    description: "Loops and monitors that are running, plus any that failed or lost their process, which need attention. Read straight from the state files, so it is cheap enough for the dashboard's 2 s poll. Supports `If-None-Match`.",
  })
  @ResponseSchema(ActiveEnvelopeDto.schema, { description: "The items." })
  list_(c: ApiContext): Promise<Response> {
    return call(this.list, c);
  }

  @Post("/active/{id}/stop", {
    summary: "Stop a loop or monitor",
    description: "Stops the loop or monitor and marks its run cancelled. Answers 404 for an id that does not exist and 400 for one that is not a loop or monitor id.",
  })
  @Param(ActiveIdParamsDto.schema)
  @ResponseSchema(OkDto.schema, { description: "Stopped." })
  @ResponseSchema(ErrorDto.schema, { status: 400, description: "Not a loop or monitor id." })
  @ResponseSchema(ErrorDto.schema, { status: 404, description: "No such loop or monitor." })
  stop_(c: ApiContext): Promise<Response> {
    return call(this.stop, c);
  }
}
