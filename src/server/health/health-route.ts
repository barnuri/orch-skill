import type { RunHealthEnvelope } from "../../shared/types/run-health";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import { runExists } from "../runs/runs-reader";
import type { ServerContext } from "../types/server-context";
import type { HealthWatcher } from "./health-watcher";
import { healthWatcherFor } from "./health-watcher";
import type { HerdrWatcher } from "./herdr-watcher";
import { herdrWatcherFor } from "./herdr-watcher";

/** `GET /api/runs/{id}/health`: the latest in-memory check; one pass when nothing is cached yet. 404 for an unknown run. */
export function readRunHealthHandler(ctx: ServerContext, watcher: HealthWatcher = healthWatcherFor(ctx.paths)): RouteHandler {
  return async (req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    if (!runExists(ctx.paths, id)) {
      return notFound();
    }
    const bypass = new URL(req.url).searchParams.get("cache") === "skip";
    let entry = bypass ? null : watcher.readCached(id);
    if (entry === null) {
      entry = await watcher.check(id, true);
    }
    const body: RunHealthEnvelope = {
      generated_at: new Date().toISOString(),
      source: entry === null ? "none" : entry.source,
      health: entry === null ? null : entry.health,
      cache: bypass
        ? { mode: "bypass", source: "fresh", age_ms: 0 }
        : { mode: "cache", source: entry === null ? "miss" : "hit", age_ms: entry === null ? 0 : Math.max(0, Date.now() - entry.at) },
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
  return async (req: Request): Promise<Response> => {
    const bypass = new URL(req.url).searchParams.get("cache") === "skip";
    return jsonResponse(200, {
      ...watcher.summary(),
      herdr: await herdr.read(),
      cache: bypass
        ? { mode: "bypass", source: "fresh", age_ms: 0 }
        : { mode: "cache", source: "hit", age_ms: 0 },
    });
  };
}
