import type { SwApp } from "./sw-strategy";

export const appOfPath = (pathname: string): SwApp => (pathname === "/chat" || pathname.startsWith("/chat/") ? "chat" : "dashboard");
export const APP_NAME: Readonly<Record<SwApp, string>> = { dashboard: "Orch", chat: "Orch chat" };
export const SW_URL: Readonly<Record<SwApp, string>> = { dashboard: "/sw.js", chat: "/chat/sw.js" };
export const SW_SCOPE: Readonly<Record<SwApp, string>> = { dashboard: "/", chat: "/chat/" };

/** `#/chats/<id>` is a chat; `new` and the list are not. */
export function chatIdOfHash(hash: string): string | null {
  const m = /^#\/chats\/([^/?#]+)/.exec(hash);
  return m === null || m[1] === "new" ? null : decodeURIComponent(m[1] as string);
}

export const isIos = (ua: string): boolean => /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);

export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode: the choice lasts until the page closes
  }
}

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function authHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}
