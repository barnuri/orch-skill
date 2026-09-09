import type { ApiError } from "../../shared/types/api-error";
import type { RunEnvelope } from "../../shared/types/run-envelope";
import type { RunsEnvelope } from "../../shared/types/runs-envelope";
import { etagOf } from "../documents/document-store";
import type { RouteHandler } from "../http/route";
import { jsonResponse, notFound, notModified } from "../http/responses";
import { readRun, listRuns } from "../runs/runs-reader";
import type { ServerContext } from "../types/server-context";

const IF_NONE_MATCH: string = "if-none-match";
const ETAG_HEADER: string = "ETag";
const CORRUPT_STATE: string = "state.json is not valid JSON";

// The ETag covers the payload only — never `generated_at` — so an unchanged runs/ tree yields a 304.
function payloadEtag(payload: unknown): string {
  return etagOf(new TextEncoder().encode(JSON.stringify(payload)));
}

export function listRunsHandler(ctx: ServerContext): RouteHandler {
  return (req: Request): Response => {
    const runs = listRuns(ctx.paths);
    const etag = payloadEtag(runs);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const body: RunsEnvelope = { generated_at: new Date().toISOString(), runs };
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}

// `params.id` arrives percent-decoded from Bun; `readRun` rejects anything outside the id alphabet.
export function readRunHandler(ctx: ServerContext): RouteHandler {
  return (req: Request, params: Readonly<Record<string, string>>): Response => {
    const result = readRun(ctx.paths, params.id ?? "");
    if (result.kind === "missing") {
      return notFound();
    }
    if (result.kind === "corrupt") {
      const error: ApiError = { error: CORRUPT_STATE };
      return jsonResponse(500, error);
    }
    const etag = payloadEtag(result.run);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const body: RunEnvelope = { generated_at: new Date().toISOString(), run: result.run };
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}
