import { resolve } from "node:path";

import type { ActiveEnvelope } from "../../shared/types/active-envelope";
import type { ApiError } from "../../shared/types/api-error";
import { readActive } from "../active/active-reader";
import { etagOf } from "../documents/document-store";
import { jsonResponse, notModified } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
const IF_NONE_MATCH: string = "if-none-match";
// Ids are minted by dispatch.sh as <kind>-<date>-<time>-<hex>; anything else never reaches the shell.
const ACTIVE_ID: RegExp = /^(loop|watch)-\d{8}-\d{6}-[0-9a-f]{4}$/;

// The loops and watches live under the state dir. `readActive` reads them directly; a recorded pid
// that no longer exists is reported as "lost", exactly as `dispatch.sh active` does.
export function listActiveHandler(ctx: ServerContext): RouteHandler {
  return (req: Request): Response => {
    const items = readActive(ctx.paths.home);
    const etag = etagOf(new TextEncoder().encode(JSON.stringify(items)));
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const body: ActiveEnvelope = { generated_at: new Date().toISOString(), items };
    return jsonResponse(200, body, { ETag: etag });
  };
}

export function stopActiveHandler(ctx: ServerContext): RouteHandler {
  return async (_req: Request, params: Readonly<Record<string, string>>): Promise<Response> => {
    const id = params.id ?? "";
    const match = ACTIVE_ID.exec(id);
    if (match === null) {
      const error: ApiError = { error: "invalid loop or watch id" };
      return jsonResponse(400, error);
    }
    const proc = Bun.spawn(["bash", DISPATCH, match[1] as string, "stop", id], {
      env: { ...process.env, HARNESS_ORCH_HOME: ctx.paths.home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const error: ApiError = { error: err.trim() || out.trim() || `dispatch exited ${code}` };
      return jsonResponse(code === 2 ? 404 : 500, error);
    }
    return jsonResponse(200, { ok: true, output: out.trim() });
  };
}
