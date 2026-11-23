import { statSync } from "node:fs";
import { join } from "node:path";

import type { RunOverview } from "../../shared/types/run-overview";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import { dispatchPath } from "../dispatch-path";
import { readRun } from "./runs-reader";
import type { ServerContext } from "../types/server-context";

export const OVERVIEW_TIMEOUT_MS: number = 60_000;

export interface OverviewSpawnResult {
  code: number;
  stdout: string;
}

/** Runs `dispatch.ts run overview <args>` for one state home. Injected so tests need no real dispatch. */
export type OverviewSpawner = (home: string, args: readonly string[]) => Promise<OverviewSpawnResult>;

export const spawnOverview: OverviewSpawner = async (home, args) => {
  const proc = Bun.spawn([process.execPath, dispatchPath(), "run", "overview", ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), OVERVIEW_TIMEOUT_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } finally {
    clearTimeout(timer);
  }
};

function parseOverview(text: string, runId: string): RunOverview | null {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && parsed.run_id === runId ? (parsed as RunOverview) : null;
  } catch {
    return null;
  }
}

export const OVERVIEW_CACHE_MS: number = 15_000;

interface OverviewCacheEntry { at: number; stateMtime: number; value: RunOverview | null; pending: Promise<RunOverview | null> | null }
const overviewCache = new Map<string, OverviewCacheEntry>();

/** Test hook: forget every cached overview. */
export function resetOverviewCache(): void {
  overviewCache.clear();
}

/**
 * One overview per run at a time. A request inside OVERVIEW_CACHE_MS of the last build, with an unchanged state file, gets the
 * cached value; concurrent requests share the build in flight, so a busy page never starts a second `dispatch.ts` process.
 */
async function cachedOverview(ctx: ServerContext, id: string, spawn: OverviewSpawner): Promise<RunOverview | null> {
  const key = `${ctx.paths.home}:${id}`;
  const stateMtime = mtimeOf(join(ctx.paths.runs, id, "state.json"));
  const hit = overviewCache.get(key);
  if (hit !== undefined) {
    if (hit.pending !== null) return hit.pending;
    if (hit.value !== null && hit.stateMtime === stateMtime && Date.now() - hit.at < OVERVIEW_CACHE_MS) return hit.value;
  }
  const entry: OverviewCacheEntry = { at: 0, stateMtime, value: hit?.value ?? null, pending: null };
  entry.pending = (async () => {
    const result = await spawn(ctx.paths.home, [id, "--json"]);
    return result.code === 0 ? parseOverview(result.stdout, id) : null;
  })();
  overviewCache.set(key, entry);
  try {
    const built = await entry.pending;
    entry.at = Date.now();
    entry.value = built ?? entry.value;
    return built;
  } finally {
    entry.pending = null;
  }
}

/** `GET /api/runs/{id}/overview`: the run overview built by `dispatch.ts run overview <id> --json`. 404 for an unknown run, 502 when dispatch fails. */
export function readRunOverviewHandler(ctx: ServerContext, spawn: OverviewSpawner = spawnOverview): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    if (readRun(ctx.paths, id).kind === "missing") {
      return notFound();
    }
    const overview = await cachedOverview(ctx, id, spawn);
    if (overview === null) {
      return jsonResponse(502, { error: "run overview: dispatch.ts did not return the overview" });
    }
    return jsonResponse(200, overview);
  };
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** `GET /api/runs/{id}/overview.html`: the page `<run>/overview.html`. Regenerated when it is missing or older than the run state; otherwise served as is. 404 for an unknown run. */
export function readRunOverviewHtmlHandler(ctx: ServerContext, spawn: OverviewSpawner = spawnOverview): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    if (readRun(ctx.paths, id).kind === "missing") {
      return notFound();
    }
    const runDir = join(ctx.paths.runs, id);
    const file = join(runDir, "overview.html");
    if (mtimeOf(file) < mtimeOf(join(runDir, "state.json"))) {
      const result = await spawn(ctx.paths.home, [id]);
      if (result.code !== 0) {
        return jsonResponse(502, { error: "run overview: dispatch.ts could not write the overview" });
      }
    }
    const html = await Bun.file(file).text();
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  };
}
