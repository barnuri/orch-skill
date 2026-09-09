import type { ServerContext } from "../types/server-context";
import { isAuthorized } from "./auth";
import { hostAllowed } from "./host-policy";
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
 * Wraps handlers in the /api/* pipeline: Host check → Bearer auth → method
 * → handler, with any handler exception collapsed to a 500 that discloses
 * nothing to the client.
 */
export function apiRoute(
  ctx: ServerContext,
  handlers: RouteHandlers,
): (req: Request) => Promise<Response> {
  const allow: readonly string[] = Object.keys(handlers);
  return async (req: Request): Promise<Response> => {
    const response = await dispatch(ctx, handlers, allow, req);
    logRequest(req, response.status);
    return response;
  };
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
): Promise<Response> {
  if (!hostAllowed(req.headers.get("host"), ctx.bindHost, ctx.hostname)) {
    return badHost();
  }
  if (!isAuthorized(req, ctx.tokenDigest)) {
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
