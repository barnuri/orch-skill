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

/** `GET /api/runs/{id}/overview`: the run overview built by `dispatch.ts run overview <id> --json`. 404 for an unknown run, 502 when dispatch fails. */
export function readRunOverviewHandler(ctx: ServerContext, spawn: OverviewSpawner = spawnOverview): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    if (readRun(ctx.paths, id).kind === "missing") {
      return notFound();
    }
    const result = await spawn(ctx.paths.home, [id, "--json"]);
    const overview = result.code === 0 ? parseOverview(result.stdout, id) : null;
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
