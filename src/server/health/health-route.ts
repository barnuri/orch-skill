import type { RunHealthEnvelope } from "../../shared/types/run-health";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import { readRun } from "../runs/runs-reader";
import type { ServerContext } from "../types/server-context";
import type { HealthWatcher } from "./health-watcher";
import { healthWatcherFor } from "./health-watcher";
import type { HerdrWatcher } from "./herdr-watcher";
import { herdrWatcherFor } from "./herdr-watcher";

/** `GET /api/runs/{id}/health`: the latest in-memory check; one pass when nothing is cached yet. 404 for an unknown run. */
export function readRunHealthHandler(ctx: ServerContext, watcher: HealthWatcher = healthWatcherFor(ctx.paths)): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    if (readRun(ctx.paths, id).kind === "missing") {
      return notFound();
    }
    const entry = await watcher.read(id);
    const body: RunHealthEnvelope = {
      generated_at: new Date().toISOString(),
      source: entry === null ? "none" : entry.source,
      health: entry === null ? null : entry.health,
    };
    return jsonResponse(200, body);
  };
}

/** `GET /api/health/summary`: counts from the watcher's memory, plus the orch herdr instance's latest check. */
export function healthSummaryHandler(
  ctx: ServerContext,
  watcher: HealthWatcher = healthWatcherFor(ctx.paths),
  herdr: HerdrWatcher = herdrWatcherFor(ctx.paths.home),
): RouteHandler {
  return async (): Promise<Response> => jsonResponse(200, { ...watcher.summary(), herdr: await herdr.read() });
}
