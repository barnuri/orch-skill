import { dispatchPath } from "../dispatch-path";
import { statSync } from "node:fs";

import type { ApiError } from "../../shared/types/api-error";
import type { HarnessesEnvelope } from "../../shared/types/harness-status";
import { jsonResponse } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { parseJsonStrict } from "../validation/strict-json";

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
  const proc = Bun.spawn(["bash", dispatchPath(), "harness", "list", "--json"], {
    env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
    killSignal: "SIGKILL",
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

export interface HarnessesHandlerOptions {
  probe?: (ctx: ServerContext) => Promise<HarnessesEnvelope | ApiError>;
  ttlMs?: number;
}

/**
 * The probe starts a `dispatch.sh`, so it is not cheap: under load it takes longer than the cache TTL, so a
 * plain TTL cache is expired by the time most callers arrive. The cache is therefore stale-while-revalidate:
 * an expired entry is served at once and refreshed by one background probe. Concurrent callers share one probe.
 * Only the first call, `?refresh=1` (the Re-detect button) and a change to profiles.json wait for a probe.
 */
export function listHarnessesHandler(ctx: ServerContext, options: HarnessesHandlerOptions = {}): RouteHandler {
  const probeFn = options.probe ?? probe;
  const ttlMs = options.ttlMs ?? HARNESS_CACHE_MS;
  let cached: Cached | null = null;
  let inflight: Promise<HarnessesEnvelope | ApiError> | null = null;

  const start = (): Promise<HarnessesEnvelope | ApiError> => {
    const run = probeFn(ctx)
      .then((result) => {
        // Stamped after the probe: `dispatch.sh` may itself touch profiles.json while it runs,
        // and a stamp taken before would never match again.
        if (!("error" in result)) {
          cached = { at: Date.now(), stamp: stampOf(ctx.paths.profiles), body: result };
        }
        return result;
      })
      .finally(() => {
        if (inflight === run) {
          inflight = null;
        }
      });
    inflight = run;
    return run;
  };

  return async (req: Request): Promise<Response> => {
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    if (!force && cached !== null && cached.stamp === stampOf(ctx.paths.profiles)) {
      if (Date.now() - cached.at >= ttlMs && inflight === null) {
        start().catch(() => undefined);
      }
      return jsonResponse(200, cached.body);
    }
    const result = await (force || inflight === null ? start() : inflight);
    return "error" in result ? jsonResponse(500, result) : jsonResponse(200, result);
  };
}
