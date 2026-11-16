// Pure rules of the service workers: unit-tested, and bundled into /sw.js and /chat/sw.js.
export type SwApp = "dashboard" | "chat";
export type Strategy = "bypass" | "network-first" | "cache-first";

/** Never cached or answered by a worker: private data, the CA, the token, the workers themselves. */
const NEVER: readonly RegExp[] = [/^\/api(\/|$)/, /^\/artifact-view\//, /^\/ca\.(crt|mobileconfig)$/, /^\/trust$/, /^\/(chat\/)?sw\.js$/, /^\/chat\/share$/, /\.(pem|key)$/i];
// Bun names bundled chunks `chunk-<8 hex/alnum>.js|css` and hashed assets `<name>-<hash>.<ext>`: the name changes with the content.
const HASHED = /-[a-z0-9]{8,}\.(js|css|woff2?|ttf|png|jpg|svg|wasm)$/i;

export interface RequestFacts {
  method: string;
  url: string;
  mode: string;
  origin: string;
}

export function classify(req: RequestFacts): Strategy {
  if (req.method !== "GET") return "bypass";
  const url = new URL(req.url);
  if (url.origin !== req.origin) return "bypass";
  if (url.searchParams.has("token") || NEVER.some((re) => re.test(url.pathname))) return "bypass";
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname === "/chat" || url.pathname.startsWith("/chat/")) return "network-first";
  if (url.pathname === "/manifest.webmanifest" || url.pathname.endsWith("/manifest.webmanifest")) return "network-first";
  if (HASHED.test(url.pathname)) return "cache-first";
  return "bypass";
}

export const cacheName = (app: SwApp, version: string): string => `orch-${app}-${version}`;

/** On activate: drop every orch cache of this app that is not the current version. Other apps' caches stay. */
export const staleCaches = (names: readonly string[], app: SwApp, version: string): string[] => names.filter((n) => n.startsWith(`orch-${app}-`) && n !== cacheName(app, version));

export const appOfScope = (scope: string): SwApp => (new URL(scope).pathname.startsWith("/chat/") ? "chat" : "dashboard");

export const OFFLINE_URL = "/offline.html";

export interface NotificationPlan {
  title: string;
  options: {
    body: string;
    tag: string;
    icon: string;
    badge: string;
    data: unknown;
    actions: { action: string; title: string }[];
    renotify: boolean;
    dir: "auto";
  };
  badge: number | null;
}

/** What to show for a push payload. A malformed payload still shows something, because browsers require a notification per push. */
export function planNotification(raw: unknown): NotificationPlan {
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, d: string): string => (typeof v === "string" && v !== "" ? v : d);
  const icon = p["icon"] === "chat" ? "/pwa/icons/chat-192.png" : "/pwa/icons/dashboard-192.png";
  const actions = Array.isArray(p["actions"]) ? (p["actions"] as { action?: unknown; title?: unknown }[]).filter((a) => typeof a.action === "string" && typeof a.title === "string").slice(0, 2).map((a) => ({ action: a.action as string, title: a.title as string })) : [];
  const tag = str(p["tag"], "orch");
  return {
    title: str(p["title"], "Orch"),
    options: { body: str(p["body"], ""), tag, icon, badge: "/pwa/icons/badge-96.png", data: p["data"] ?? { url: str(p["url"], "/"), tag }, actions, renotify: true, dir: "auto" },
    badge: typeof p["badge"] === "number" ? p["badge"] : null,
  };
}
