import { resolve } from "node:path";

import { type PwaApp, manifestFor } from "./manifest";
import { serviceWorkerSource } from "./sw-build";

const STATIC_DIR = resolve(import.meta.dir, "../../web/pwa/static");

const OFFLINE_HTML = `<!doctype html><html lang="en" dir="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Orch is not reachable</title>
<style>:root{color-scheme:light dark;--bg:light-dark(#f4f5f7,#0b0d10);--tx:light-dark(#14171c,#e8eaee);--tx2:light-dark(#5a616d,#9aa2af);--acc:light-dark(#1857c4,#3d8bfd);--onacc:light-dark(#fff,#0b0d10)}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--tx);font:16px/1.5 system-ui,sans-serif}
main{max-width:26rem;padding:1.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1.5rem;color:var(--tx2)}
a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 1.5rem;border-radius:6px;background:var(--acc);color:var(--onacc);font-weight:600;text-decoration:none}
a:focus-visible{outline:2px solid var(--tx);outline-offset:2px}</style></head>
<body><main><h1>The server is not reachable</h1><p>Orch could not reach the server. Check that it is running and that this device is on the same network, then try again.</p><a href="">Retry</a></main></body></html>`;

const OFFLINE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" };

export function manifestResponse(app: PwaApp): Response {
  return new Response(JSON.stringify(manifestFor(app)), { headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" } });
}

export async function swResponse(app: PwaApp): Promise<Response> {
  const { code } = await serviceWorkerSource();
  return new Response(code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // The browser re-checks the worker on every navigation; a stale cached worker would block updates.
      "cache-control": "no-cache",
      "service-worker-allowed": app === "chat" ? "/chat/" : "/",
    },
  });
}

/** Share target: the shared text becomes the first message's draft on the chat page (`?share=`). Text only, no files. */
export function shareResponse(req: Request): Response {
  const q = new URL(req.url).searchParams;
  const text = [q.get("title"), q.get("text"), q.get("url")].filter((x): x is string => x !== null && x !== "").join("\n").slice(0, 4000);
  return new Response(null, { status: 303, headers: { location: text === "" ? "/chat/" : `/chat/?share=${encodeURIComponent(text)}`, "cache-control": "no-store" } });
}

const ICON = /^(chat|dashboard)-(192|512|maskable-512|apple-touch-180|favicon-32|favicon-48)\.png$|^badge-96\.png$/;

export function iconResponse(name: string): Response {
  if (!ICON.test(name)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(resolve(STATIC_DIR, "icons", name)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}

/** Bun `routes` for both installable apps. HTTP stays the default; browsers allow all of this on http://localhost and on https. */
export function pwaRoutes(): Record<string, (req: Request & { params?: Record<string, string> }) => Response | Promise<Response>> {
  return {
    "/manifest.webmanifest": () => manifestResponse("dashboard"),
    "/chat/manifest.webmanifest": () => manifestResponse("chat"),
    "/sw.js": () => swResponse("dashboard"),
    "/chat/sw.js": () => swResponse("chat"),
    "/offline.html": () => new Response(OFFLINE_HTML, { headers: OFFLINE_HEADERS }),
    "/chat/share": (req) => shareResponse(req),
    "/pwa/icons/:name": (req) => iconResponse(req.params?.["name"] ?? ""),
  };
}
