import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { ApiError } from "../../shared/types/api-error";
import type { HarnessesEnvelope } from "../../shared/types/harness-status";
import { jsonResponse } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { parseJsonStrict } from "../validation/strict-json";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
export const HARNESS_CACHE_MS: number = 20_000;

interface Cached {
  at: number;
  /** profiles.json mtime when probed: a change (a harness toggled) makes the cache stale at once. */
  stamp: number;
  body: HarnessesEnvelope;
}

function stampOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function probe(ctx: ServerContext): Promise<HarnessesEnvelope | ApiError> {
  const proc = Bun.spawn(["bash", DISPATCH, "harness", "list", "--json"], {
    env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    return { error: err.trim() || text.trim() || `dispatch exited ${code}` };
  }
  const parsed = parseJsonStrict(text.trim());
  return parsed.ok ? (parsed.value as HarnessesEnvelope) : { error: `invalid harness output: ${parsed.error}` };
}

/**
 * The probe starts a `dispatch.sh`, so it is not cheap (up to ~2 s on a loaded machine). It is async,
 * so it never stalls other requests; it is cached for HARNESS_CACHE_MS; and concurrent callers
 * share one probe. `?refresh=1` (the Re-detect button) and a change to profiles.json both skip the cache.
 */
export function listHarnessesHandler(ctx: ServerContext): RouteHandler {
  let cached: Cached | null = null;
  let inflight: Promise<HarnessesEnvelope | ApiError> | null = null;

  return async (req: Request): Promise<Response> => {
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    if (!force && cached !== null && cached.stamp === stampOf(ctx.paths.profiles) && Date.now() - cached.at < HARNESS_CACHE_MS) {
      return jsonResponse(200, cached.body);
    }
    if (inflight === null || force) {
      const run = probe(ctx).finally(() => {
        if (inflight === run) {
          inflight = null;
        }
      });
      inflight = run;
    }
    const result = await inflight;
    if ("error" in result) {
      return jsonResponse(500, result);
    }
    // Stamped after the probe: `dispatch.sh` may itself touch profiles.json while it runs (a migration),
    // and a stamp taken before would never match again.
    cached = { at: Date.now(), stamp: stampOf(ctx.paths.profiles), body: result };
    return jsonResponse(200, result);
  };
}
