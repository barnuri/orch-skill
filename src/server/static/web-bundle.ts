import { resolve } from "node:path";

import { type Encoding, MIN_COMPRESS_BYTES, compressBytes, pickEncoding } from "../http/compress";

const WEB_DIR: string = resolve(import.meta.dir, "../../web");
const ENTRIES: readonly string[] = ["index.html", "chat.html"];
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;
// Compress text types only; images and fonts are already compact.
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;

interface Asset {
  type: string;
  body: Uint8Array;
  hashed: boolean;
  etag: string;
  encoded: Map<Encoding, Promise<Uint8Array>>;
}

export interface WebBundle {
  /** Looks up `/chunk-xyz.js` style paths. `/` and `/chat` pages come from `page`. */
  asset(pathname: string): Asset | undefined;
  page(name: "index" | "chat"): Asset;
}

/** Content-hashed names (`chunk-<hash>.js`, `name-<hash>.png`) never change content, so they cache forever. */
const HASHED_NAME = /-[a-z0-9]{8,}\.[a-z0-9]+$/i;

/**
 * Builds the dashboard and chat pages once per process, code-split (dynamic imports become their own chunks) and
 * minified, entirely in memory. Bun's own HTML-route bundler does not split, which shipped one 7 MB chunk.
 */
export async function buildWebBundle(): Promise<WebBundle> {
  const out = await Bun.build({
    entrypoints: ENTRIES.map((f) => resolve(WEB_DIR, f)),
    target: "browser",
    splitting: true,
    minify: true,
    publicPath: "/",
  });
  if (!out.success) throw new Error(`web bundle build failed: ${out.logs.map(String).join("; ")}`);
  const assets = new Map<string, Asset>();
  for (const o of out.outputs) {
    const name = o.path.replace(/^\.\//, "");
    assets.set(`/${name}`, {
      type: o.type,
      body: new Uint8Array(await o.arrayBuffer()),
      hashed: HASHED_NAME.test(name) && !name.endsWith(".html"),
      etag: `"${o.hash ?? name}"`,
      encoded: new Map(),
    });
  }
  const pages = { index: assets.get("/index.html"), chat: assets.get("/chat.html") };
  if (pages.index === undefined || pages.chat === undefined) throw new Error("web bundle build produced no html page");
  return { asset: (p) => assets.get(p), page: (n) => pages[n] as Asset };
}

let built: Promise<WebBundle> | null = null;

/** One build per process. A failed build is retried on the next request. */
export function webBundle(): Promise<WebBundle> {
  built ??= buildWebBundle();
  built.catch(() => {
    built = null;
  });
  return built;
}

/** Answers a static asset: Content-Encoding by Accept-Encoding, compressed once per asset and encoding. */
export async function assetResponse(req: Request, asset: Asset): Promise<Response> {
  const headers = new Headers({
    ...SECURITY,
    "Content-Type": asset.type,
    ETag: asset.etag,
    "Cache-Control": asset.hashed ? "public, max-age=31536000, immutable" : "no-cache",
    Vary: "Accept-Encoding",
  });
  if (req.headers.get("If-None-Match") === asset.etag) return new Response(null, { status: 304, headers });
  let body: Uint8Array = asset.body;
  const enc = COMPRESSIBLE.test(asset.type) && asset.body.byteLength >= MIN_COMPRESS_BYTES / 8 ? pickEncoding(req.headers.get("Accept-Encoding")) : null;
  if (enc !== null) {
    let p = asset.encoded.get(enc);
    if (p === undefined) {
      p = compressBytes(asset.body, enc, false);
      asset.encoded.set(enc, p);
    }
    body = await p;
    headers.set("Content-Encoding", enc);
  }
  headers.set("Content-Length", String(body.byteLength));
  return new Response(req.method === "HEAD" ? null : (body as BodyInit), { status: 200, headers });
}
