import type { RouteHandler } from "../../http/route";
import type { ApiContext } from "../pipeline";

/** Runs an existing request handler for a decorated route, passing the raw request and path params. */
export function call(handler: RouteHandler, c: ApiContext): Promise<Response> {
  return Promise.resolve(handler(c.req.raw, c.req.param()));
}

type Target = "json" | "query" | "param";

/** The zod-validated part of the request, as the registrar's validators left it. */
export function valid<T>(c: ApiContext, target: Target): T {
  return (c.req as unknown as { valid(target: Target): unknown }).valid(target) as T;
}
