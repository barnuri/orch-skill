import { useEffect, useState } from "react";
import { appOfPath, isIos, isStandalone, recall, remember } from "./app";
import type { SwApp } from "./sw-strategy";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export const dismissKey = (app: SwApp): string => `orch.pwa.install.dismissed.${app}`;

export interface InstallState {
  app: SwApp;
  /** The browser offered an install (Chrome, Edge, Android). */
  canPrompt: boolean;
  installed: boolean;
  /** Safari on iOS has no prompt: the person adds it from the Share menu. */
  iosHint: boolean;
  dismissed: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
}

export function useInstall(): InstallState {
  const app = appOfPath(location.pathname);
  const [, tick] = useState(0);
  const [dismissed, setDismissed] = useState(() => recall(dismissKey(app)) === "1");
  useEffect(() => {
    const on = (): void => tick((n) => n + 1);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  const installed = isStandalone();
  return {
    app,
    canPrompt: deferred !== null && !installed,
    installed,
    iosHint: !installed && isIos(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent),
    dismissed,
    install: async () => {
      const e = deferred;
      if (e === null) return;
      await e.prompt();
      const choice = await e.userChoice;
      deferred = null;
      // Cancel in the browser's own install dialog counts as "no": do not offer it again.
      if (choice.outcome === "dismissed") {
        remember(dismissKey(app), "1");
        setDismissed(true);
      }
      notify();
    },
    dismiss: () => {
      remember(dismissKey(app), "1");
      setDismissed(true);
    },
  };
}
