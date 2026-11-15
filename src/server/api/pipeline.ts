import type { Server } from "bun";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ServerContext } from "../types/server-context";
import { hostAllowed } from "../http/host-policy";
import { authorized, logError, logRequest } from "../http/route";
import { badHost, jsonResponse, methodNotAllowed, notFound, unauthorized } from "../http/responses";

/** What Bun hands `fetch` and the app passes on: the server, so a request's peer address is known. */
export interface ApiEnv {
  Bindings: { server: Server<undefined> };
}

export type ApiContext = Context<ApiEnv>;

const METHOD_ORDER: readonly string[] = ["GET", "PUT", "POST"];

/**
 * The /api/* gate, run in front of every declared route: Host check, then auth, then the handler,
 * then the request log. It is installed per controller (not app-wide), so a path nobody declared
 * still answers 404 without asking for a token, as before.
 */
export function guard(ctx: ServerContext): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const req = c.req.raw;
    if (!hostAllowed(req.headers.get("host"), ctx.bindHost, ctx.hostname)) {
      return badHost();
    }
    if (!authorized(ctx, req, c.env.server)) {
      return unauthorized();
    }
    await next();
    logRequest(req, c.res.status);
    return undefined;
  };
}

/** A validation failure answers in the API's own `{ "error": "<path>: <reason>" }` shape. */
export function validationHook(
  result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } },
  c: Context,
): Response | undefined {
  if (result.success) {
    return undefined;
  }
  const first = result.error?.issues[0];
  const where = first === undefined || first.path.length === 0 ? "" : `${first.path.map(String).join(".")}: `;
  return c.json({ error: `${where}${first?.message ?? "invalid request"}` }, 400);
}

// `/api/runs/:id` -> a regex. Hono 404s a known path used with the wrong verb; this API says 405.
function patternOf(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+")}$`);
}

function allowedMethods(app: OpenAPIHono<ApiEnv>, pathname: string): string[] {
  const found = new Set<string>();
  for (const route of app.routes) {
    if (METHOD_ORDER.includes(route.method) && patternOf(route.path).test(pathname)) {
      found.add(route.method);
    }
  }
  return METHOD_ORDER.filter((method) => found.has(method));
}

/** 404 for a path nobody declared; 405 with `Allow` for a declared path used with the wrong verb. */
export function installFallbacks(app: OpenAPIHono<ApiEnv>, ctx: ServerContext): void {
  app.notFound((c) => {
    const allow = allowedMethods(app, new URL(c.req.url).pathname);
    if (allow.length === 0) {
      return notFound();
    }
    // A known path: the same Host and auth checks come first, so a 405 is never a way to probe.
    const req = c.req.raw;
    if (!hostAllowed(req.headers.get("host"), ctx.bindHost, ctx.hostname)) {
      return badHost();
    }
    if (!authorized(ctx, req, c.env.server)) {
      return unauthorized();
    }
    const response = methodNotAllowed(allow);
    logRequest(req, response.status);
    return response;
  });
  // The stack goes to stderr only; the client learns nothing beyond "internal".
  app.onError((err, c) => {
    // A body the validator could not parse (not JSON, wrong content type) is the caller's mistake.
    if (err instanceof HTTPException && err.status === 400) {
      const response = jsonResponse(400, { error: "request body is not valid JSON" });
      logRequest(c.req.raw, response.status);
      return response;
    }
    logError(err);
    const response = jsonResponse(500, { error: "internal" });
    logRequest(c.req.raw, response.status);
    return response;
  });
}
