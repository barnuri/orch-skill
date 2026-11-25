import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** JSON smaller than this is sent as is: the CPU and the header cost more than the saving. */
export const MIN_COMPRESS_BYTES: number = 8 * 1024;
const CACHE_MAX_BYTES: number = 64 * 1024 * 1024;

export type Encoding = "br" | "gzip";

/** The best encoding the client accepts (br before gzip), or null. Honors `;q=0`. */
export function pickEncoding(acceptEncoding: string | null): Encoding | null {
  if (acceptEncoding === null) return null;
  const q = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    q.set(name as string, qp === undefined ? 1 : Number(qp.slice(2)));
  }
  const ok = (n: string): boolean => (q.get(n) ?? q.get("*") ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}

export function compressBytes(data: Uint8Array, enc: Encoding, fast = true): Promise<Uint8Array> {
  if (enc === "gzip") return gzipAsync(data, { level: fast ? 4 : 9 });
  return brotliAsync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: fast ? 4 : 9, [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength } });
}

// Compressed JSON bodies by `<etag>|<encoding>`: an unchanged payload (same ETag) is compressed once. Oldest entries go first.
const cache = new Map<string, Uint8Array>();
let cacheBytes = 0;

function remember(key: string, body: Uint8Array): void {
  cache.set(key, body);
  cacheBytes += body.byteLength;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= v.byteLength;
  }
}

/** Test seam. */
export function clearCompressCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/** Compresses a JSON 200 over 8 KB when the client accepts it. Anything else is returned unchanged. */
export async function compressJsonResponse(req: Request, res: Response): Promise<Response> {
  if (req.method !== "GET" || res.status !== 200 || res.body === null || res.headers.has("Content-Encoding")) return res;
  if (!(res.headers.get("Content-Type") ?? "").startsWith("application/json")) return res;
  const enc = pickEncoding(req.headers.get("Accept-Encoding"));
  if (enc === null) return res;
  const raw = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.append("Vary", "Accept-Encoding");
  if (raw.byteLength < MIN_COMPRESS_BYTES) return new Response(raw, { status: 200, headers });
  const etag = res.headers.get("ETag");
  const key = etag === null ? null : `${etag}|${enc}`;
  let body = key === null ? undefined : cache.get(key);
  if (body === undefined) {
    body = await compressBytes(raw, enc);
    if (key !== null) remember(key, body);
  }
  headers.set("Content-Encoding", enc);
  headers.set("Content-Length", String(body.byteLength));
  return new Response(body as BodyInit, { status: 200, headers });
}
