import { Controller, Get, Response as ResponseSchema } from "@barnuri/hono-decorators";

import type { RouteHandler } from "../../http/route";
import type { ServerContext } from "../../types/server-context";
import { watchdogHandler } from "../../watchdog/watchdog-route";
import { WatchdogStatusDto } from "../../../shared/dto/watchdog";
import type { ApiContext } from "../pipeline";
import { call } from "./support";

@Controller({ path: "/api", tags: ["runs"] })
export class WatchdogController {
  private readonly status: RouteHandler;

  constructor(ctx: ServerContext) {
    this.status = watchdogHandler(ctx);
  }

  @Get("/watchdog", {
    summary: "The run watchdog",
    description:
      "The server's watchdog, which runs the deterministic babysitting steps for orch runs: auto-dispatch of ready nodes, lost-node retry, stall reports, re-queue of done nodes without handoff.md, one retry of infrastructure errors, and `run finish` when every node of an auto_dispatch run is done. Answers its state, the last 50 actions (newest first, also in `<home>/watchdog/actions.log`), per-run counters and open flags. The dashboard header polls it.",
  })
  @ResponseSchema(WatchdogStatusDto.schema, { description: "The watchdog's status." })
  getWatchdog(c: ApiContext): Promise<Response> {
    return call(this.status, c);
  }
}
