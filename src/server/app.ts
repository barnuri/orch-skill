import type { Server } from "bun";
import { hostname } from "node:os";
import { resolve } from "node:path";

import index from "../dashboard/index.html";
import webIndex from "../web/index.html";
import { buildApi } from "./api/build-api";
import { orchPaths } from "./files/paths";
import { jsonResponse } from "./http/responses";
import { logError } from "./http/route";
import { MAX_UPLOAD_REQUEST_BYTES } from "./chats/limits";
import { MAX_BODY_BYTES } from "./routes/document-routes";
import type { ServerContext } from "./types/server-context";
import type { ServerOptions } from "./types/server-options";

// Declared beside the PUT handler that enforces it; re-exported here as the server's public limit.
export { MAX_BODY_BYTES };

export const DASHBOARD_DIR: string = resolve(import.meta.dir, "../dashboard");
// Headroom over the JSON limit so `readJsonBody` gets to answer a descriptive 413 before Bun's empty one.
export const BODY_SLACK_BYTES: number = 64 * 1024;

// Every dashboard request is fast except one: POST /api/profiles/sanity runs a real harness
// call per profile and takes tens of seconds. At the old 15 s this request was cut off
// mid-sweep, so "Sanity test all" could never return. SANITY_TIMEOUT_MS bounds the child, and
// this bounds the socket — it has to be the larger of the two.
const IDLE_TIMEOUT_SECONDS: number = 240;

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
  const api = buildApi(ctx);
  return Bun.serve({
    hostname: options.host,
    port: options.port,
    development: false,
    // Explicit: without it a second `orch serve` silently steals the port from the running
    // one — the first process stays alive but stops receiving requests. We want EADDRINUSE
    // so `main` can exit 1 and bash can reuse the server that is already up.
    reusePort: false,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    // Bun has one body cap per server, no per-route cap, so the upload size is the cap for every /api route.
    // JSON routes still enforce their own MAX_BODY_BYTES while reading; uploads stream to disk (upload-stream.ts)
    // and enforce the per-file and per-message limits as bytes arrive, so no request is buffered whole.
    maxRequestBodySize: Math.max(MAX_BODY_BYTES + BODY_SLACK_BYTES, MAX_UPLOAD_REQUEST_BYTES),
    // Only the dashboard page is a Bun route (it is an HTML import Bun bundles); every /api/* path,
    // and everything unlisted, goes to the Hono app, whose fallback answers 404 or 405.
    routes: { "/": index, "/next": webIndex },
    fetch: (req: Request, server: Server<undefined>): Response | Promise<Response> => api.fetch(req, { server }),
    // Stack goes to stderr only; the client learns nothing beyond "internal".
    error: (err: Error): Response => {
      logError(err);
      return jsonResponse(500, { error: "internal" });
    },
  });
}
