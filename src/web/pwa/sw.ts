import { safeClickUrl } from "../../shared/push";
import { OFFLINE_URL, appOfScope, cacheName, classify, planNotification, staleCaches } from "./sw-strategy";

// Bundled by the server (src/server/pwa/sw-build.ts) into /sw.js (scope /) and /chat/sw.js (scope /chat/).
declare const __SW_VERSION__: string;

interface Ev extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEv extends Ev {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
interface PushEv extends Ev {
  data: { json(): unknown } | null;
}
interface ClickEv extends Ev {
  notification: Notification & { data?: { url?: string } };
}
interface Win {
  url: string;
  focus(): Promise<unknown>;
  postMessage(m: unknown): void;
}
interface Sw {
  registration: ServiceWorkerRegistration & { showNotification(t: string, o?: object): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(o: object): Promise<Win[]>; openWindow(u: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
  location: Location;
  addEventListener(t: string, h: (e: never) => void): void;
}
const sw = self as unknown as Sw;
const APP = appOfScope(sw.registration.scope);
const CACHE = cacheName(APP, __SW_VERSION__);

sw.addEventListener("install", ((e: Ev) => {
  // No skipWaiting here: a waiting worker is what lets the page offer "Update available".
  e.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" }))));
}) as never);

sw.addEventListener("activate", ((e: Ev) => {
  e.waitUntil(caches.keys().then((names) => Promise.all(staleCaches(names, APP, __SW_VERSION__).map((n) => caches.delete(n)))).then(() => sw.clients.claim()));
}) as never);

sw.addEventListener("message", ((e: { data?: { type?: string } }) => {
  if (e.data?.type === "SKIP_WAITING") void sw.skipWaiting();
}) as never);

async function networkFirst(req: Request, fallbackOffline: boolean): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) void cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit !== undefined) return hit;
    const offline = fallbackOffline ? await cache.match(OFFLINE_URL) : undefined;
    return offline ?? new Response("offline", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit !== undefined) return hit;
  const res = await fetch(req);
  if (res.ok) void cache.put(req, res.clone());
  return res;
}

sw.addEventListener("fetch", ((e: FetchEv) => {
  const strategy = classify({ method: e.request.method, url: e.request.url, mode: e.request.mode, origin: sw.location.origin });
  if (strategy === "network-first") e.respondWith(networkFirst(e.request, e.request.mode === "navigate"));
  else if (strategy === "cache-first") e.respondWith(cacheFirst(e.request));
}) as never);

sw.addEventListener("push", ((e: PushEv) => {
  let raw: unknown = null;
  try {
    raw = e.data?.json() ?? null;
  } catch {
    raw = null;
  }
  const plan = planNotification(raw);
  const nav = sw.registration as unknown as { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  const badge = self.navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  const setBadge = plan.badge === null ? Promise.resolve() : plan.badge > 0 ? (badge.setAppBadge?.(plan.badge) ?? nav.setAppBadge?.(plan.badge) ?? Promise.resolve()) : (badge.clearAppBadge?.() ?? Promise.resolve());
  e.waitUntil(Promise.all([sw.registration.showNotification(plan.title, plan.options), setBadge.catch(() => undefined)]));
}) as never);

sw.addEventListener("notificationclick", ((e: ClickEv) => {
  e.notification.close();
  const url = safeClickUrl(e.notification.data?.url, sw.location.origin);
  e.waitUntil(
    sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (wins) => {
      const target = wins.find((w) => new URL(w.url).origin === sw.location.origin);
      if (target !== undefined) {
        target.postMessage({ type: "orch:navigate", url });
        await target.focus();
        return;
      }
      await sw.clients.openWindow(url);
    }),
  );
}) as never);
