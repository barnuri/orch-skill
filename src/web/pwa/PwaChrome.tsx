import "./pwa.css";
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { NotificationsSection } from "./NotificationsSection";
import { APP_NAME, appOfPath, recall, remember } from "./app";
import { pushSupport } from "./push-client";
import { useInstall } from "./install";
import { usePresence } from "./presence";
import { registerWorker, useNotificationNavigation, useWorkerUpdate } from "./register";
import { consumeShare } from "./share";

export const OPEN_NOTIFICATIONS_EVENT = "orch:open-notifications";

function UpdateToast() {
  const { waiting, apply } = useWorkerUpdate();
  if (!waiting) return null;
  return (
    <div className="pwa-bar pwa-update" role="status">
      <span>Update available</span>
      <Button variant="primary" onClick={apply}>Reload</Button>
    </div>
  );
}

/** A quiet, dismissable offer; the answer is remembered per app. The same install lives in Settings. */
function InstallPrompt() {
  const install = useInstall();
  if (install.installed || install.dismissed || !(install.canPrompt || install.iosHint)) return null;
  const name = APP_NAME[install.app];
  return (
    <div className="pwa-bar pwa-install" role="note">
      {install.canPrompt ? <span>Install {name} as an app.</span> : <span>To install {name}, tap Share, then Add to Home Screen.</span>}
      {install.canPrompt ? <Button variant="primary" onClick={() => void install.install()}>Install</Button> : null}
      <Button onClick={install.dismiss}>Not now</Button>
    </div>
  );
}

const NUDGE_KEY = "orch.pwa.notifyNudge.dismissed";

/** Chat app only: it has no settings page, so a quiet offer opens the Notifications dialog. Never asks the permission itself. */
function NotifyNudge() {
  const [dismissed, setDismissed] = useState(() => recall(NUDGE_KEY) === "1");
  const install = useInstall();
  const ready = pushSupport().ok && "Notification" in window && Notification.permission === "default";
  if (appOfPath(location.pathname) !== "chat" || dismissed || !ready || (install.canPrompt && !install.dismissed)) return null;
  return (
    <div className="pwa-bar pwa-install" role="note">
      <span>Get a notification when a reply is ready.</span>
      <Button variant="primary" onClick={() => window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT))}>Set up</Button>
      <Button onClick={() => { remember(NUDGE_KEY, "1"); setDismissed(true); }}>Not now</Button>
    </div>
  );
}

function NotificationsDialog() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("notifications") === "1");
  useEffect(() => {
    const on = (): void => setOpen(true);
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, on);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, on);
  }, []);
  if (!open) return null;
  return (
    <div className="pwa-scrim" role="presentation" onClick={() => setOpen(false)}>
      <dialog open className="pwa-dialog" aria-label="Notifications" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
        <NotificationsSection />
        <div className="actions"><Button onClick={() => setOpen(false)}>Close</Button></div>
      </dialog>
    </div>
  );
}

/** Installability, updates, notification clicks and the visible-chat heartbeat for either app. Mount once next to the shell. */
export function PwaChrome() {
  usePresence();
  useNotificationNavigation();
  useEffect(() => {
    void registerWorker();
    consumeShare();
  }, []);
  return (
    <>
      <UpdateToast />
      <InstallPrompt />
      <NotifyNudge />
      <NotificationsDialog />
    </>
  );
}
