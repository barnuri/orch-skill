import type { Server } from "bun";
import { hostname } from "node:os";
import { resolve } from "node:path";

import index from "../dashboard/index.html";
import { orchPaths } from "./files/paths";
import { jsonResponse, notFound } from "./http/responses";
import { apiRoute, logError } from "./http/route";
import {
  MAX_BODY_BYTES,
  getDocumentHandler,
  putDocumentHandler,
} from "./routes/document-routes";
import { healthHandler } from "./routes/health-route";
import { listRunsHandler, readRunHandler } from "./routes/runs-routes";
import type { ServerContext } from "./types/server-context";
import type { ServerOptions } from "./types/server-options";

// Declared beside the PUT handler that enforces it; re-exported here as the server's public limit.
export { MAX_BODY_BYTES };

export const DASHBOARD_DIR: string = resolve(import.meta.dir, "../dashboard");
// Headroom over the JSON limit so `readJsonBody` gets to answer a descriptive 413 before Bun's empty one.
export const BODY_SLACK_BYTES: number = 64 * 1024;

const IDLE_TIMEOUT_SECONDS: number = 15;

function contextOf(options: ServerOptions): ServerContext {
  return {
    paths: orchPaths(options.home),
    bindHost: options.host,
    hostname: hostname(),
    tokenDigest: options.tokenDigest,
    requireToken: options.requireToken,
    requireRemoteToken: options.requireRemoteToken,
    harnesses: options.harnesses,
    outcomes: options.outcomes,
  };
}

/**
 * Binds the dashboard + `/api/*` server. Changes the process cwd to the dashboard
 * directory first — Bun emits the bundled chunk URLs relative to `process.cwd()`,
 * so from any other cwd they resolve to `/../../dashboard/chunk-…` and 404.
 */
export function startServer(options: ServerOptions): Server<undefined> {
  process.chdir(DASHBOARD_DIR);
  const ctx = contextOf(options);
  return Bun.serve({
    hostname: options.host,
    port: options.port,
    development: false,
    // Explicit: without it a second `orch serve` silently steals the port from the running
    // one — the first process stays alive but stops receiving requests. We want EADDRINUSE
    // so `main` can exit 1 and bash can reuse the server that is already up.
    reusePort: false,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: MAX_BODY_BYTES + BODY_SLACK_BYTES,
    routes: {
      "/": index,
      "/api/health": apiRoute(ctx, { GET: healthHandler(ctx) }),
      "/api/runs": apiRoute(ctx, { GET: listRunsHandler(ctx) }),
      "/api/runs/:id": apiRoute(ctx, { GET: readRunHandler(ctx) }),
      "/api/profiles": apiRoute(ctx, {
        GET: getDocumentHandler(ctx, "profiles"),
        PUT: putDocumentHandler(ctx, "profiles"),
      }),
      "/api/memory": apiRoute(ctx, {
        GET: getDocumentHandler(ctx, "memory"),
        PUT: putDocumentHandler(ctx, "memory"),
      }),
    },
    // Nothing else is served, so the fallback needs no auth: 404 for every unlisted path.
    fetch: (): Response => notFound(),
    // Stack goes to stderr only; the client learns nothing beyond "internal".
    error: (err: Error): Response => {
      logError(err);
      return jsonResponse(500, { error: "internal" });
    },
  });
}
