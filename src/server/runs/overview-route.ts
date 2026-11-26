import { statSync } from "node:fs";
import { join } from "node:path";

import type { RunOverview } from "../../shared/types/run-overview";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound } from "../http/responses";
import { dispatchPath } from "../dispatch-path";
import { buildRunOverview } from "../../../skills/orch/core/commands/overview.ts";
import { readRun } from "./runs-reader";
import type { ServerContext } from "../types/server-context";

/** Longest the dashboard waits for GitHub pull request lookups on one build; slower lookups finish in the background and show on the next refresh. */
export const OVERVIEW_PULLS_WAIT_MS: number = 150;
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

/**
 * Default spawner: `--json` is a read, so it runs in-process (no CLI start, no second parse of the run state).
 * Anything else writes overview.html and goes through `dispatch.ts`, which owns every write.
 */
export const inProcessOverview: OverviewSpawner = async (home, args) => {
  if (!args.includes("--json")) return spawnOverview(home, args);
  const id = args.find((a) => !a.startsWith("--")) ?? "";
  try {
    const overview = await buildRunOverview(home, id, { pullsWaitMs: OVERVIEW_PULLS_WAIT_MS });
    return overview === null ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify(overview) };
  } catch {
    return { code: 1, stdout: "" };
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

interface OverviewCacheEntry { at: number; value: RunOverview | null; pending: Promise<RunOverview | null> | null }
const overviewCache = new Map<string, OverviewCacheEntry>();

/** Test hook: forget every cached overview. */
export function resetOverviewCache(): void {
  overviewCache.clear();
}

/**
 * One overview per run at a time, served stale-while-revalidate: a value younger than OVERVIEW_CACHE_MS is returned as is
 * (whatever the state file mtime does); an older value is returned at once while one background build refreshes it. Only
 * the first request for a run waits for a build. Concurrent requests share the build in flight, so a busy page never
 * starts a second `dispatch.ts` process.
 */
async function cachedOverview(ctx: ServerContext, id: string, spawn: OverviewSpawner): Promise<RunOverview | null> {
  const key = `${ctx.paths.home}:${id}`;
  const hit = overviewCache.get(key);
  if (hit !== undefined) {
    if (hit.value !== null && (hit.pending !== null || Date.now() - hit.at < OVERVIEW_CACHE_MS)) return hit.value;
    if (hit.pending !== null) return hit.pending;
  }
  const entry: OverviewCacheEntry = { at: 0, value: hit?.value ?? null, pending: null };
  const build = (async () => {
    try {
      const result = await spawn(ctx.paths.home, [id, "--json"]);
      return result.code === 0 ? parseOverview(result.stdout, id) : null;
    } catch {
      return null;
    }
  })().then((built) => {
    entry.at = Date.now();
    entry.value = built ?? entry.value;
    return built;
  }).finally(() => {
    entry.pending = null;
  });
  entry.pending = build;
  overviewCache.set(key, entry);
  // A stale value is served now; the build refreshes it in the background.
  return entry.value !== null ? entry.value : build;
}

/** `GET /api/runs/{id}/overview`: the run overview built by `dispatch.ts run overview <id> --json`. 404 for an unknown run, 502 when dispatch fails. */
export function readRunOverviewHandler(ctx: ServerContext, spawn: OverviewSpawner = inProcessOverview): RouteHandler {
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
export function readRunOverviewHtmlHandler(ctx: ServerContext, spawn: OverviewSpawner = inProcessOverview): RouteHandler {
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
