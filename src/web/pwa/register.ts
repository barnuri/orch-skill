import { useEffect, useState } from "react";
import { getToken } from "../api/token";
import { appOfPath, SW_SCOPE, SW_URL } from "./app";

/** Workers need https or localhost; on plain http the page simply runs without one. */
export const workersAllowed = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  registration ??= (async () => {
    if (!workersAllowed()) return null;
    const app = appOfPath(location.pathname);
    // The chat app's scope is /chat/: keep the page inside it, hash and query intact.
    if (app === "chat" && location.pathname === "/chat") history.replaceState(null, "", `/chat/${location.search}${location.hash}`);
    try {
      return await navigator.serviceWorker.register(SW_URL[app], { scope: SW_SCOPE[app] });
    } catch {
      return null;
    }
  })();
  return registration;
}

/** True while a new worker waits. `apply` activates it and reloads once it controls the page. */
export function useWorkerUpdate(): { waiting: boolean; apply: () => void } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    let off = (): void => {};
    void registerWorker().then((reg) => {
      if (reg === null) return;
      const check = (): void => {
        // `controller` is null on the very first install: nothing to update then.
        if (reg.waiting !== null && navigator.serviceWorker.controller !== null) setWaiting(reg.waiting);
      };
      check();
      const onFound = (): void => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed") check();
        });
      };
      reg.addEventListener("updatefound", onFound);
      const timer = setInterval(() => void reg.update().catch(() => {}), 30 * 60_000);
      off = () => {
        reg.removeEventListener("updatefound", onFound);
        clearInterval(timer);
      };
    });
    return () => off();
  }, []);
  const apply = (): void => {
    if (waiting === null) return;
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
    waiting.postMessage({ type: "SKIP_WAITING" });
  };
  return { waiting: waiting !== null, apply };
}

/** The worker asks an open window to go to a notification's url. Only same-origin paths are followed. */
export function useNotificationNavigation(): void {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    const on = (e: MessageEvent): void => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type !== "orch:navigate" || typeof data.url !== "string") return;
      const u = new URL(data.url, location.origin);
      if (u.origin === location.origin) location.href = u.toString();
    };
    navigator.serviceWorker.addEventListener("message", on);
    return () => navigator.serviceWorker.removeEventListener("message", on);
  }, []);
}

export { getToken };
