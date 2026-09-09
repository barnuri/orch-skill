import type { Server } from "bun";

import type { ServerContext } from "../types/server-context";
import { isAuthorized } from "./auth";
import { hostAllowed } from "./host-policy";
import { isLoopbackPeer } from "./loopback";
import { badHost, jsonResponse, methodNotAllowed, unauthorized } from "./responses";

export type RouteHandler = (
  req: Request,
  params: Readonly<Record<string, string>>,
) => Response | Promise<Response>;

export type RouteHandlers = Partial<Record<"GET" | "PUT", RouteHandler>>;

type RouteMethod = keyof RouteHandlers;

const VERBOSE_ENV: string = "ORCH_SERVE_VERBOSE";
const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Wraps handlers in the /api/* pipeline: Host check → auth → method → handler,
 * with any handler exception collapsed to a 500 that discloses nothing to the
 * client. Bun passes the server as the second argument, which is what makes the
 * requesting peer's address available to `authorized`.
 */
export function apiRoute(
  ctx: ServerContext,
  handlers: RouteHandlers,
): (req: Request, server: Server<undefined>) => Promise<Response> {
  const allow: readonly string[] = Object.keys(handlers);
  return async (req: Request, server: Server<undefined>): Promise<Response> => {
    const response = await dispatch(ctx, handlers, allow, req, server);
    logRequest(req, response.status);
    return response;
  };
}

/**
 * A request from this machine needs no token: whoever made it could already read the token file,
 * so asking for it back adds friction without adding a barrier. Every other peer — the LAN case
 * binding `0.0.0.0` exists for — still presents the bearer token. `--require-token` demands it
 * from loopback too, which is what a shared multi-user host wants.
 */
function authorized(ctx: ServerContext, req: Request, server: Server<undefined>): boolean {
  if (!ctx.requireToken && isLoopbackPeer(server, req)) {
    return true;
  }
  return isAuthorized(req, ctx.tokenDigest);
}

export function logError(err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`serve: internal error: ${detail}`);
}

async function dispatch(
  ctx: ServerContext,
  handlers: RouteHandlers,
  allow: readonly string[],
  req: Request,
  server: Server<undefined>,
): Promise<Response> {
  if (!hostAllowed(req.headers.get("host"), ctx.bindHost, ctx.hostname)) {
    return badHost();
  }
  if (!authorized(ctx, req, server)) {
    return unauthorized();
  }
  const handler = handlerFor(handlers, req.method);
  if (handler === undefined) {
    return methodNotAllowed(allow);
  }
  try {
    return await handler(req, paramsOf(req));
  } catch (err: unknown) {
    logError(err);
    return jsonResponse(500, { error: "internal" });
  }
}

function handlerFor(handlers: RouteHandlers, method: string): RouteHandler | undefined {
  return isRouteMethod(method) ? handlers[method] : undefined;
}

function isRouteMethod(method: string): method is RouteMethod {
  return method === "GET" || method === "PUT";
}

// Bun hands route handlers a BunRequest whose `params` carry the matched `:id` segments.
function paramsOf(req: Request): Readonly<Record<string, string>> {
  if (!("params" in req) || typeof req.params !== "object" || req.params === null) {
    return NO_PARAMS;
  }
  return req.params as Readonly<Record<string, string>>;
}

// Only the pathname is logged — the query string never reaches stderr.
function logRequest(req: Request, status: number): void {
  const verbose = Boolean(process.env[VERBOSE_ENV]);
  if (!verbose && req.method !== "PUT" && status < 400) {
    return;
  }
  const { pathname } = new URL(req.url);
  console.error(`${req.method} ${pathname} ${status}`);
}
