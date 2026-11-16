import type { Server, TLSOptions } from "bun";
import { hostname } from "node:os";
import { resolve } from "node:path";

import chatIndex from "../web/chat.html";
import webIndex from "../web/index.html";
import { CHAT_ICON_DARK, CHAT_ICON_LIGHT, chatManifestResponse, chatIconResponse } from "./chat-only-routes";
import { buildApi } from "./api/build-api";
import { orchPaths } from "./files/paths";
import { jsonResponse } from "./http/responses";
import { logError } from "./http/route";
import { MAX_UPLOAD_REQUEST_BYTES } from "./chats/limits";
import { caCrtResponse, mobileConfigResponse, trustPageResponse } from "./tls/trust-routes";
import { MAX_BODY_BYTES } from "./routes/document-routes";
import type { ServerContext } from "./types/server-context";
import type { ServerOptions } from "./types/server-options";

// Declared beside the PUT handler that enforces it; re-exported here as the server's public limit.
export { MAX_BODY_BYTES };

export const DASHBOARD_DIR: string = resolve(import.meta.dir, "../web");
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
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.httpsPort === undefined ? {} : { httpsPort: options.httpsPort }),
    ...(options.secureLinkHint === undefined ? {} : { secureLinkHint: options.secureLinkHint }),
  };
}

type Api = ReturnType<typeof buildApi>;

/** One Hono app shared by the HTTP listener and the optional HTTPS listener. */
export function buildApp(options: ServerOptions): Api {
  return buildApi(contextOf(options));
}

function listen(options: ServerOptions, api: Api, hostPort: { port: number; tls?: TLSOptions }): Server<undefined> {
  process.chdir(DASHBOARD_DIR);
  const ctx = contextOf(options);
  const trust = { tls: ctx.tls, hostname: ctx.hostname, bindHost: ctx.bindHost };
  return Bun.serve({
    hostname: options.host,
    port: hostPort.port,
    ...(hostPort.tls === undefined ? {} : { tls: hostPort.tls }),
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
    // Only the dashboard page (and the retired /next redirect) is a Bun route (it is an HTML import Bun bundles); every /api/* path,
    // and everything unlisted, goes to the Hono app, whose fallback answers 404 or 405.
    routes: {
      "/": webIndex,
      "/chat": chatIndex,
      "/chat/": chatIndex,
      "/chat/manifest.webmanifest": () => chatManifestResponse(),
      "/chat/icon.svg": () => chatIconResponse(CHAT_ICON_LIGHT),
      "/chat/icon-dark.svg": () => chatIconResponse(CHAT_ICON_DARK),
      "/chat/:id": chatIndex,
      // Public CA only (no token, no key): lets a phone trust the optional HTTPS listener.
      "/ca.crt": () => caCrtResponse(trust),
      "/ca.mobileconfig": () => mobileConfigResponse(trust),
      "/trust": (req: Request) => trustPageResponse(trust, req),
      /* unknown paths below /chat/ fall to the Hono 404 via `fetch` */ "/next": Response.redirect("/", 301),
    },
    fetch: (req: Request, server: Server<undefined>): Response | Promise<Response> => api.fetch(req, { server }),
    // Stack goes to stderr only; the client learns nothing beyond "internal".
    error: (err: Error): Response => {
      logError(err);
      return jsonResponse(500, { error: "internal" });
    },
  });
}

/**
 * Binds the dashboard + `/api/*` server over plain HTTP. Changes the process cwd to the dashboard
 * directory first — Bun emits the bundled chunk URLs relative to `process.cwd()`,
 * so from any other cwd they resolve to `/../../dashboard/chunk-…` and 404.
 */
export function startServer(options: ServerOptions, api: Api = buildApp(options)): Server<undefined> {
  return listen(options, api, { port: options.port });
}

/** The opt-in HTTPS listener: same app, same routes, same auth. A failure here never touches the HTTP one. */
export function startHttpsServer(options: ServerOptions, httpsPort: number, tls: { cert: string; key: string }, api: Api = buildApp(options)): Server<undefined> {
  return listen(options, api, { port: httpsPort, tls: { cert: tls.cert, key: tls.key } });
}
