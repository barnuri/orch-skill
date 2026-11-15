import { jsonResponse } from "./responses";

export type BodyResult = { ok: true; text: string } | { ok: false; response: Response };

const JSON_MEDIA_TYPE: string = "application/json";

/** True when the request carries no body at all — no media type and nothing declared. */
function hasNoBody(req: Request): boolean {
  if (req.headers.get("content-type") !== null) {
    return false;
  }
  const declared = parseContentLength(req.headers.get("content-length"));
  return declared === null || declared === 0;
}

/**
 * Reads a JSON request body, refusing wrong media types (415) and oversized
 * bodies (413) — by declared Content-Length before reading, then by real byte
 * length after. Bun's `maxRequestBodySize` stays the backstop for chunked liars.
 *
 * `allowEmpty` is for endpoints whose body is genuinely optional (a sanity sweep over every
 * profile, "apply all"): a request with no body has no media type to declare, so demanding
 * one would 415 the no-argument call. A request that does carry a body is still checked.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
  allowEmpty: boolean = false,
): Promise<BodyResult> {
  if (allowEmpty && hasNoBody(req)) {
    return { ok: true, text: "" };
  }
  if (mediaTypeOf(req.headers.get("content-type")) !== JSON_MEDIA_TYPE) {
    return {
      ok: false,
      response: jsonResponse(415, { error: "Content-Type must be application/json" }),
    };
  }
  const declaredLength = parseContentLength(req.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    return payloadTooLarge(maxBytes);
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return payloadTooLarge(maxBytes);
  }
  return { ok: true, text };
}

function mediaTypeOf(contentType: string | null): string {
  if (contentType === null) {
    return "";
  }
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function parseContentLength(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const length = Number(header.trim());
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function payloadTooLarge(maxBytes: number): BodyResult {
  return { ok: false, response: jsonResponse(413, { error: `body exceeds ${maxBytes} bytes` }) };
}
