import { Controller, Get, Response as ResponseSchema } from "@barnuri/hono-decorators";

import { healthHandler } from "../../routes/health-route";
import type { RouteHandler } from "../../http/route";
import type { ServerContext } from "../../types/server-context";
import { HealthDto } from "../../../shared/dto/common";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["health"] })
export class HealthController {
  private readonly health: RouteHandler;

  constructor(ctx: ServerContext) {
    this.health = healthHandler(ctx);
  }

  @Get("/health", {
    summary: "Server health",
    description: "Answers 200 with the server's pid, state directory and Bun version. The service supervisor and `dispatch.sh` use it to tell a live server from a stale one.",
  })
  @ResponseSchema(HealthDto.schema, { description: "The server is up." })
  getHealth(c: ApiContext): Promise<Response> {
    return call(this.health, c);
  }
}
