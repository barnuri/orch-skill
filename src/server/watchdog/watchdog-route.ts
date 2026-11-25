import type { RouteHandler } from "../http/route";
import { jsonResponse } from "../http/responses";
import type { ServerContext } from "../types/server-context";
import type { WatchdogService } from "./watchdog-service";
import { watchdogFor } from "./watchdog-service";
import { remoteWatchdogStatus } from "../background/bridge";

/** `GET /api/watchdog`: state, newest actions, per-run counters and open flags, from the background worker's last snapshot (from memory when no worker runs). */
export function watchdogHandler(ctx: ServerContext, watchdog: WatchdogService = watchdogFor(ctx.paths.home)): RouteHandler {
  return (): Response => jsonResponse(200, remoteWatchdogStatus(ctx.paths.home) ?? watchdog.status());
}
