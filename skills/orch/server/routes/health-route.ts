import type { HealthResponse } from "../../shared/types/health-response";
import type { RouteHandler } from "../http/route";
import { jsonResponse } from "../http/responses";
import type { ServerContext } from "../types/server-context";

export function healthHandler(ctx: ServerContext): RouteHandler {
  return (): Response => {
    const body: HealthResponse = {
      ok: true,
      pid: process.pid,
      home: ctx.paths.home,
      version: Bun.version,
    };
    return jsonResponse(200, body);
  };
}
