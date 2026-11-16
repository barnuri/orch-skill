import type { RouteHandler } from "../http/route";
import { jsonResponse } from "../http/responses";
import type { ServerContext } from "../types/server-context";
import type { WatchdogService } from "./watchdog-service";
import { watchdogFor } from "./watchdog-service";

/** `GET /api/watchdog`: state, newest actions, per-run counters and open flags, from memory. */
export function watchdogHandler(ctx: ServerContext, watchdog: WatchdogService = watchdogFor(ctx.paths.home)): RouteHandler {
  return (): Response => jsonResponse(200, watchdog.status());
}
