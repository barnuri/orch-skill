import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { appOfScope, cacheName, classify, planNotification, staleCaches } from "../../web/pwa/sw-strategy";
import { startTestServer } from "../test-support/test-server";
import { manifestHref } from "../../web/pwa/head";
import { manifestFor } from "./manifest";

const srv = startTestServer();
afterAll(() => srv.stop());
const get = (p: string): Promise<Response> => fetch(new URL(p, srv.url));

interface Manifest {
  id: string; name: string; short_name: string; scope: string; start_url: string; display: string; dir: string; lang: string; orientation: string;
  theme_color: string; background_color: string; description: string; categories: string[];
  icons: { src: string; sizes: string; type: string; purpose: string }[]; shortcuts: { name: string; url: string }[]; share_target?: { action: string; method: string };
  display_override?: unknown;
}

const pngSize = (bytes: Uint8Array): { w: number; h: number; sig: boolean } => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  return { sig: bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, w: dv.getUint32(16), h: dv.getUint32(20) };
};

describe("manifests", () => {
  const dash = (): Promise<Manifest> => get("/manifest.webmanifest").then((r) => r.json() as Promise<Manifest>);
  const chat = (): Promise<Manifest> => get("/chat/manifest.webmanifest").then((r) => r.json() as Promise<Manifest>);

  test("served as application/manifest+json, no-cache", async () => {
    for (const p of ["/manifest.webmanifest", "/chat/manifest.webmanifest"]) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/manifest+json");
      expect(r.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("two different apps: ids differ, the chat scope nests in the dashboard's, start urls are in scope", async () => {
    const [d, c] = [await dash(), await chat()];
    expect(d).toMatchObject({ id: "/", name: "Orch", short_name: "Orch", scope: "/", start_url: "/", display: "standalone", dir: "auto", orientation: "any" });
    expect(c).toMatchObject({ id: "/chat/", name: "Orch chat", scope: "/chat/", start_url: "/chat/", display: "standalone", dir: "auto", orientation: "any" });
    expect(d.id).not.toBe(c.id);
    expect(c.scope.startsWith(d.scope)).toBe(true);
    expect(c.start_url.startsWith(c.scope)).toBe(true);
    for (const m of [d, c]) {
      expect(m.display_override).toBeUndefined();
      expect(m.theme_color).toBe("#0b0d10");
      expect(m.background_color).toBe("#0b0d10");
      expect(m.lang).toBe("en");
      expect(m.description.length).toBeGreaterThan(10);
    }
  });

  test("shortcuts and the share target", async () => {
    const [d, c] = [await dash(), await chat()];
    expect(d.shortcuts.map((s) => s.name)).toEqual(["Runs", "Chats"]);
    expect(c.shortcuts.map((s) => s.name)).toEqual(["New chat"]);
    expect(c.share_target).toMatchObject({ action: "/chat/share", method: "GET" });
    expect(d.share_target).toBeUndefined();
    const r = await fetch(new URL("/chat/share?title=T&text=hello%20there", srv.url), { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/chat/?share=T%0Ahello%20there");
  });

  test("icons: 192, 512 and maskable 512 resolve as PNGs of the declared size; the two apps use different files", async () => {
    const [d, c] = [await dash(), await chat()];
    for (const m of [d, c]) {
      expect(m.icons.map((i) => `${i.sizes}:${i.purpose}`)).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
      for (const icon of m.icons) {
        const r = await get(icon.src);
        expect(r.headers.get("content-type")).toBe("image/png");
        const { sig, w, h } = pngSize(new Uint8Array(await r.arrayBuffer()));
        expect(sig).toBe(true);
        expect(`${w}x${h}`).toBe(icon.sizes);
      }
    }
    expect(d.icons[0]!.src).not.toBe(c.icons[0]!.src);
  });

  test("apple-touch 180, favicons and the badge exist with the right size, and the colour treatment differs", async () => {
    const sizes: Record<string, number> = { "apple-touch-180": 180, "favicon-32": 32, "favicon-48": 48 };
    const bytes: Record<string, Uint8Array> = {};
    for (const app of ["dashboard", "chat"]) {
      for (const [k, n] of Object.entries(sizes)) {
        const b = new Uint8Array(await (await get(`/pwa/icons/${app}-${k}.png`)).arrayBuffer());
        bytes[`${app}-${k}`] = b;
        expect(pngSize(b)).toMatchObject({ sig: true, w: n, h: n });
      }
    }
    expect(pngSize(new Uint8Array(await (await get("/pwa/icons/badge-96.png")).arrayBuffer())).w).toBe(96);
    expect(Buffer.from(bytes["dashboard-apple-touch-180"]!).equals(Buffer.from(bytes["chat-apple-touch-180"]!))).toBe(false);
    expect((await get("/pwa/icons/../../x.png")).status).toBe(404);
    expect((await get("/pwa/icons/evil.png")).status).toBe(404);
  });

  test("manifestFor is the served document", async () => {
    expect(JSON.parse(JSON.stringify(manifestFor("chat")))).toEqual(await chat());
  });
});

describe("pages", () => {
  test("each shell links its own manifest, theme-color for both schemes, apple touch icon and allows workers and manifests in the CSP", async () => {
    for (const [path, manifest, icon] of [["/", "/manifest.webmanifest", "dashboard"], ["/chat", "/chat/manifest.webmanifest", "chat"]] as const) {
      const html = await (await get(path)).text();
      expect(html).toMatch(new RegExp(`rel="apple-touch-icon" href="[^"]*${icon}-apple-touch-180[^"]*\\.png"`));
      expect(manifestHref(path)).toBe(manifest);
      expect(html).toContain('name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)"');
      expect(html).toContain('name="theme-color" content="#f4f5f7" media="(prefers-color-scheme: light)"');
      expect(html).toContain("apple-mobile-web-app-capable");
      expect(html).toContain("apple-mobile-web-app-status-bar-style");
      expect(html).toContain("manifest-src 'self'");
      expect(html).toContain("worker-src 'self'");
    }
  });
});

describe("service workers", () => {
  test("served as javascript with no-cache and the scope they may take", async () => {
    for (const [p, scope] of [["/sw.js", "/"], ["/chat/sw.js", "/chat/"]] as const) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("javascript");
      expect(r.headers.get("cache-control")).toBe("no-cache");
      expect(r.headers.get("service-worker-allowed")).toBe(scope);
      const code = await r.text();
      expect(code).toContain("skipWaiting");
      expect(code).toContain("notificationclick");
      expect(code).not.toContain("__SW_VERSION__");
    }
  });

  test("the offline page says the server is not reachable and has a Retry link, with a CSP", async () => {
    const r = await get("/offline.html");
    const html = await r.text();
    expect(html).toContain("not reachable");
    expect(html).toContain(">Retry</a>");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  const req = (url: string, over: Partial<{ method: string; mode: string }> = {}) => classify({ method: "GET", mode: "cors", origin: "https://h:6725", url: `https://h:6725${url}`, ...over });

  test("routes: network-first for pages, cache-first for hashed assets, never for private paths", () => {
    expect(req("/", { mode: "navigate" })).toBe("network-first");
    expect(req("/chat/", { mode: "navigate" })).toBe("network-first");
    expect(req("/chat/abc", { mode: "navigate" })).toBe("network-first");
    expect(req("/manifest.webmanifest")).toBe("network-first");
    expect(req("/chunk-a1b2c3d4.js")).toBe("cache-first");
    expect(req("/main-9f8e7d6c5b.css")).toBe("cache-first");
    for (const p of ["/api/runs", "/api/push/key", "/artifact-view/tok", "/ca.crt", "/ca.mobileconfig", "/trust", "/sw.js", "/chat/sw.js", "/x/server.key", "/chat/share"]) {
      expect(req(p)).toBe("bypass");
      expect(req(p, { mode: "navigate" })).toBe("bypass");
    }
    expect(req("/?token=abc", { mode: "navigate" })).toBe("bypass");
    expect(req("/chunk-a1b2c3d4.js?token=x")).toBe("bypass");
    expect(req("/api/runs", { method: "POST" })).toBe("bypass");
    expect(classify({ method: "GET", mode: "cors", origin: "https://h", url: "https://other.example/chunk-a1b2c3d4.js" })).toBe("bypass");
    expect(req("/plain.js")).toBe("bypass");
  });

  test("caches are versioned and only this app's old versions are cleaned", () => {
    expect(cacheName("chat", "v2")).toBe("orch-chat-v2");
    expect(staleCaches(["orch-chat-v1", "orch-chat-v2", "orch-dashboard-v1", "other"], "chat", "v2")).toEqual(["orch-chat-v1"]);
    expect(appOfScope("https://h/chat/")).toBe("chat");
    expect(appOfScope("https://h/")).toBe("dashboard");
  });

  test("a push payload becomes a notification, and a broken one still shows something", () => {
    const p = planNotification({ title: "T", body: "B", tag: "chat:1", icon: "chat", badge: 2, data: { url: "/chat/#/chats/1" }, actions: [{ action: "open", title: "Open" }, { action: "a", title: "A" }, { action: "c", title: "C" }] });
    expect(p.title).toBe("T");
    expect(p.options).toMatchObject({ body: "B", tag: "chat:1", icon: "/pwa/icons/chat-192.png", renotify: true, dir: "auto" });
    expect(p.options.actions).toHaveLength(2);
    expect(p.badge).toBe(2);
    expect(planNotification(null).title).toBe("Orch");
    expect(planNotification("junk").options.data).toEqual({ url: "/", tag: "orch" });
  });

  test("the worker source never caches the token, the key or /api", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../web/pwa/sw-strategy.ts"), "utf8");
    for (const needle of ["/api", "artifact-view", "ca\\.", "token", "pem|key"]) expect(src).toContain(needle);
  });
});
