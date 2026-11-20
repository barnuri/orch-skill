import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { getToken } from "../api/token";
import { Button } from "../components/Button";
import { PUSH_CATEGORIES, PUSH_CATEGORY_LABELS, type PushCategory, type QuietHours } from "../../shared/push";
import { APP_NAME } from "./app";
import { useInstall } from "./install";
import { type Device, currentSubscription, disablePush, enablePush, listDevices, minutesToTime, patchDevice, pushSupport, removeDevice, subscriptionId, testDevice, timeToMinutes } from "./push-client";
import { registerWorker } from "./register";

function SecureNote() {
  const info = useQuery({ queryKey: ["server-info"], staleTime: 60_000, queryFn: async () => { const r = await api.getServerInfo(); return r.kind === "ok" ? r.body : null; } });
  const url = info.data?.https_url ?? null;
  const token = getToken();
  const trust = info.data?.trust_path === null || info.data?.trust_path === undefined ? null : new URL(info.data.trust_path, url ?? location.href).toString();
  return (
    <p className="pwa-note" role="note">
      Notifications need a secure link (https).{" "}
      {url === null ? "Turn on the https port on the server first (serve config https_port on)." : (
        <>
          Open <a href={`${url}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`}>{url}</a>
          {trust === null ? null : <> and trust the certificate once at <a href={trust}>/trust</a></>}.
        </>
      )}
    </p>
  );
}

/** Why the browser offers no install here, and the one step that fixes it. */
function installBlockedHint(swOk: boolean | null): string {
  if (!window.isSecureContext) return "Blocked: the browser installs apps only over https. Open the secure link below.";
  if (swOk === false) return "Blocked: this device does not trust the server's certificate. Trust it once at /trust, then reload.";
  return "Use the browser menu (⋮): Install app or Add to Home screen.";
}

function InstallRow() {
  const i = useInstall();
  const name = APP_NAME[i.app];
  const [swOk, setSwOk] = useState<boolean | null>(null);
  useEffect(() => void registerWorker().then((r) => setSwOk(r !== null)), []);
  const blocked = !i.installed && !i.canPrompt && !i.iosHint && (!window.isSecureContext || swOk === false);
  return (
    <div className="pwa-row">
      <div>
        <strong>Install {name}</strong>
        <p className="pwa-hint">
          {i.installed ? "Installed: this window is the app." : i.canPrompt ? "Opens in its own window, with its own icon." : i.iosHint ? "Tap Share, then Add to Home Screen." : installBlockedHint(swOk)}
        </p>
        {blocked && window.isSecureContext ? <p className="pwa-hint"><a href="/trust">Open /trust</a></p> : null}
      </div>
      {i.canPrompt ? <Button variant="primary" onClick={() => void i.install()}>Install</Button> : null}
    </div>
  );
}

function Switch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="pwa-switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function NotificationsSection() {
  const support = pushSupport();
  const [devices, setDevices] = useState<Device[]>([]);
  const [self, setSelf] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "none">(() => ("Notification" in window ? Notification.permission : "none"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!support.ok) return;
    try {
      setDevices(await listDevices());
      const sub = await currentSubscription();
      setSelf(sub === null ? null : await subscriptionId(sub.endpoint));
    } catch {
      setMessage("Could not load the devices.");
    }
  }, [support.ok]);
  useEffect(() => void refresh(), [refresh]);

  const mine = devices.find((d) => d.id === self) ?? null;
  const toggleMaster = async (on: boolean): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (on) await enablePush();
      else await disablePush();
    } catch (err) {
      setMessage(err instanceof Error && err.message === "denied" ? null : "Could not change notifications.");
    } finally {
      setPermission("Notification" in window ? Notification.permission : "none");
      await refresh();
      setBusy(false);
    }
  };
  const save = async (patch: { categories?: PushCategory[]; quiet?: QuietHours }): Promise<void> => {
    if (mine === null) return;
    const next = await patchDevice(mine.id, patch);
    setDevices((all) => all.map((d) => (d.id === next.id ? next : d)));
  };
  const quiet = mine?.quiet;

  return (
    <section className="pwa-section" aria-labelledby="pwa-notif-h">
      <h3 id="pwa-notif-h">Notifications</h3>
      <InstallRow />
      {!support.ok && support.reason === "insecure" ? <SecureNote /> : null}
      {!support.ok && support.reason === "unsupported" ? <p className="pwa-note">This browser cannot show push notifications here. On iPhone, add the app to the Home Screen first (iOS 16.4 or later).</p> : null}
      {support.ok ? (
        <>
          <Switch checked={mine !== null} disabled={busy || permission === "denied"} label="Notify me on this device" onChange={(v) => void toggleMaster(v)} />
          {permission === "denied" ? <p className="pwa-note">Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</p> : null}
          {message === null ? null : <p className="pwa-note" role="alert">{message}</p>}
          {mine === null ? null : (
            <>
              <fieldset className="pwa-cats">
                <legend>Tell me about</legend>
                {PUSH_CATEGORIES.map((c) => (
                  <Switch key={c} checked={mine.categories.includes(c)} label={PUSH_CATEGORY_LABELS[c]} onChange={(v) => void save({ categories: v ? [...mine.categories, c] : mine.categories.filter((x) => x !== c) })} />
                ))}
              </fieldset>
              <div className="pwa-quiet">
                <Switch checked={quiet?.enabled === true} label="Quiet hours" onChange={(v) => void save({ quiet: { ...(quiet as QuietHours), enabled: v, tz_offset: new Date().getTimezoneOffset() } })} />
                <label>From <input type="time" value={minutesToTime(quiet?.start ?? 1320)} onChange={(e) => void save({ quiet: { ...(quiet as QuietHours), start: timeToMinutes(e.target.value), tz_offset: new Date().getTimezoneOffset() } })} /></label>
                <label>to <input type="time" value={minutesToTime(quiet?.end ?? 420)} onChange={(e) => void save({ quiet: { ...(quiet as QuietHours), end: timeToMinutes(e.target.value), tz_offset: new Date().getTimezoneOffset() } })} /></label>
              </div>
            </>
          )}
        </>
      ) : null}
      {support.ok && devices.length > 0 ? (
        <ul className="pwa-devices" aria-label="Devices">
          {devices.map((d) => (
            <li key={d.id}>
              <div>
                <strong dir="auto">{d.label}{d.id === self ? " (this device)" : ""}</strong>
                <span className="pwa-hint">{APP_NAME[d.app]} · {d.service} · {d.last_error !== null ? `last error: ${d.last_error}` : d.last_success_at === null ? "no notification sent yet" : `last sent ${new Date(d.last_success_at).toLocaleString()}`}</span>
                {tests[d.id] === undefined ? null : <span className="pwa-hint" role="status">{tests[d.id]}</span>}
              </div>
              <Button onClick={() => void testDevice(d.id).then((r) => setTests((t) => ({ ...t, [d.id]: r.ok ? "Test sent." : `Test failed: ${r.error ?? r.status}` })), () => setTests((t) => ({ ...t, [d.id]: "Test failed." }))).then(refresh)}>Test</Button>
              <Button onClick={() => void removeDevice(d.id).then(refresh)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
