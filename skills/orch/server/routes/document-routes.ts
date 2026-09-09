import type { ApiError } from "../../shared/types/api-error";
import type { DocumentKind } from "../../shared/types/document-kind";
import type { Issue } from "../../shared/types/issue";
import type { MemoryDocument } from "../../shared/types/memory-document";
import type { MemoryEnvelope } from "../../shared/types/memory-envelope";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import type { ProfilesEnvelope } from "../../shared/types/profiles-envelope";
import type { PutOk } from "../../shared/types/put-ok";
import { etagOf, readDocumentBytes, writeDocument } from "../documents/document-store";
import { readJsonBody } from "../http/body";
import { jsonResponse, notModified } from "../http/responses";
import type { RouteHandler } from "../http/route";
import type { ServerContext } from "../types/server-context";
import { memoryIssues } from "../validation/memory-validator";
import { profilesIssues } from "../validation/profiles-validator";
import { parseJsonStrict } from "../validation/strict-json";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const IF_NONE_MATCH: string = "if-none-match";
const IF_MATCH: string = "if-match";
const ETAG_HEADER: string = "ETag";
const ROOT_PATH: string = "$";
const CORRUPT_FILE_PREFIX: string = "file on disk is not valid JSON: ";
const INVALID_JSON_PREFIX: string = "invalid JSON: ";
const STALE_DOCUMENT: string = "document changed on disk; reload and retry";
const WRITE_FAILED_PREFIX: string = "write failed: ";

type DocumentEnvelope = ProfilesEnvelope | MemoryEnvelope;

function issuesOf(ctx: ServerContext, kind: DocumentKind, document: unknown): Issue[] {
  return kind === "profiles"
    ? profilesIssues(document, ctx.harnesses)
    : memoryIssues(document, ctx.outcomes);
}

// The validator has already shaped `document` (or reported why it could not); the envelope only
// carries what is on disk, so the cast is the same trust the dashboard extends to `issues`.
function envelopeOf(
  ctx: ServerContext,
  kind: DocumentKind,
  document: unknown,
  issues: Issue[],
): DocumentEnvelope {
  const limits = { max_body_bytes: MAX_BODY_BYTES };
  if (kind === "profiles") {
    return {
      document: document as ProfilesDocument | null,
      harnesses: [...ctx.harnesses],
      issues,
      limits,
    };
  }
  return {
    document: document as MemoryDocument | null,
    outcomes: [...ctx.outcomes],
    issues,
    limits,
  };
}

export function getDocumentHandler(ctx: ServerContext, kind: DocumentKind): RouteHandler {
  return (req: Request): Response => {
    const bytes = readDocumentBytes(ctx.paths, kind);
    const etag = etagOf(bytes);
    if (req.headers.get(IF_NONE_MATCH) === etag) {
      return notModified(etag);
    }
    const parsed = parseJsonStrict(new TextDecoder().decode(bytes));
    const body = parsed.ok
      ? envelopeOf(ctx, kind, parsed.value, issuesOf(ctx, kind, parsed.value))
      : envelopeOf(ctx, kind, null, [
          { path: ROOT_PATH, reason: `${CORRUPT_FILE_PREFIX}${parsed.error}` },
        ]);
    return jsonResponse(200, body, { [ETAG_HEADER]: etag });
  };
}

function errorCode(err: unknown): string {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compare-and-write with no `await` between reading the current bytes and the atomic rename, so
 * two in-process PUTs cannot interleave. The cross-process window against bash `jq > tmp && mv`
 * writers stays a documented few milliseconds.
 */
function commitDocument(
  ctx: ServerContext,
  kind: DocumentKind,
  ifMatch: string | null,
  document: unknown,
): Response {
  const current = etagOf(readDocumentBytes(ctx.paths, kind));
  if (ifMatch !== null && ifMatch !== current) {
    const error: ApiError = { error: STALE_DOCUMENT, etag: current };
    return jsonResponse(412, error);
  }
  let written: Uint8Array;
  try {
    written = writeDocument(ctx.paths, kind, document);
  } catch (err: unknown) {
    const error: ApiError = { error: `${WRITE_FAILED_PREFIX}${errorCode(err)}` };
    return jsonResponse(500, error);
  }
  const etag = etagOf(written);
  const body: PutOk = { ok: true, etag };
  return jsonResponse(200, body, { [ETAG_HEADER]: etag });
}

export function putDocumentHandler(ctx: ServerContext, kind: DocumentKind): RouteHandler {
  return async (req: Request): Promise<Response> => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      return body.response;
    }
    const parsed = parseJsonStrict(body.text);
    if (!parsed.ok) {
      const error: ApiError = { error: `${INVALID_JSON_PREFIX}${parsed.error}`, issues: [] };
      return jsonResponse(400, error);
    }
    const issues = issuesOf(ctx, kind, parsed.value);
    const [first] = issues;
    if (first !== undefined) {
      const error: ApiError = { error: `${first.path}: ${first.reason}`, issues };
      return jsonResponse(400, error);
    }
    return commitDocument(ctx, kind, req.headers.get(IF_MATCH), parsed.value);
  };
}
