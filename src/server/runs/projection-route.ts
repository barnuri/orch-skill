import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import type { ServerContext } from "../types/server-context";
import { loadRunProjection } from "../../../skills/orch/core/runs/projection";

/** `GET /api/runs/{id}/projection`: the canonical run projection, the same object `run status --json` prints as `projection`. 404 for an unknown run. */
export function readRunProjectionHandler(ctx: ServerContext): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const projection = await loadRunProjection(ctx.paths.home, params.id ?? "");
    return projection === null ? notFound() : jsonResponse(200, projection);
  };
}
