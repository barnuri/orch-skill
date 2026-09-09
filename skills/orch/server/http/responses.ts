// Every server-authored response carries these; never Access-Control-* or Set-Cookie.
export const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

const JSON_CONTENT_TYPE: string = "application/json; charset=utf-8";
const BEARER_CHALLENGE: string = 'Bearer realm="orch"';

export function jsonResponse(
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": JSON_CONTENT_TYPE, ...extra },
  });
}

export function notFound(): Response {
  return jsonResponse(404, { error: "not found" });
}

export function methodNotAllowed(allow: readonly string[]): Response {
  return jsonResponse(405, { error: "method not allowed" }, { Allow: allow.join(", ") });
}

export function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ...COMMON_HEADERS, ETag: etag } });
}

export function unauthorized(): Response {
  return jsonResponse(401, { error: "unauthorized" }, { "WWW-Authenticate": BEARER_CHALLENGE });
}

export function badHost(): Response {
  return jsonResponse(400, { error: "bad host" });
}
