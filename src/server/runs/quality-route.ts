import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import type { ServerContext } from "../types/server-context";
import { readRun } from "./runs-reader";

/** `GET /api/runs/{id}/quality`: the quality reports `dispatch.ts node quality append` stored in the run. Read only. 404 for an unknown run. */
export function readQualityHandler(ctx: ServerContext): RouteHandler {
  return (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    const loaded = readRun(ctx.paths, id);
    if (loaded.kind === "missing") return Promise.resolve(notFound());
    const reports = loaded.kind === "ok" ? ((loaded.run as { quality?: unknown[] }).quality ?? []) : [];
    return Promise.resolve(jsonResponse(200, { generated_at: new Date().toISOString(), reports }));
  };
}
