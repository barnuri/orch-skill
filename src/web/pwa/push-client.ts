import { DEFAULT_QUIET_HOURS, PUSH_CATEGORIES, type PushCategory, type QuietHours } from "../../shared/push";
import { getToken } from "../api/token";
import { authHeaders, appOfPath } from "./app";
import { registerWorker } from "./register";

export interface Device {
  id: string;
  label: string;
  user_agent: string;
  app: "chat" | "dashboard";
  service: string;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  categories: PushCategory[];
  quiet: QuietHours;
}

export type PushSupport = { ok: true } | { ok: false; reason: "insecure" | "unsupported" };

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return { ok: false, reason: "unsupported" };
  return { ok: true };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/push${path}`, {
    method,
    headers: { ...authHeaders(getToken()), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`push ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const listDevices = async (): Promise<Device[]> => (await call<{ devices: Device[] }>("GET", "/subscriptions")).devices;
export const patchDevice = (id: string, patch: { categories?: PushCategory[]; quiet?: QuietHours }): Promise<Device> => call("PATCH", `/subscriptions/${id}`, patch);
export const removeDevice = (id: string): Promise<{ removed: boolean }> => call("DELETE", `/subscriptions/${id}`);
export const testDevice = (id: string): Promise<{ ok: boolean; status: number; error: string | null }> => call("POST", "/test", { id });

/** The server stores `sha256(endpoint)[0..16]` as the id, so a page can tell which listed device is itself. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const keyBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerWorker();
  if (reg === null) return null;
  await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export const deviceLabel = (): string => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
};

/** Call from a click only: asking for the permission anywhere else is blocked or ignored by browsers. */
export async function enablePush(categories: PushCategory[] = [...PUSH_CATEGORIES], quiet: QuietHours = { ...DEFAULT_QUIET_HOURS, tz_offset: new Date().getTimezoneOffset() }): Promise<Device> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "denied" : "dismissed");
  const reg = await registerWorker();
  if (reg === null) throw new Error("no service worker");
  await navigator.serviceWorker.ready;
  const { public_key } = await call<{ public_key: string }>("GET", "/key");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }));
  return call<Device>("POST", "/subscribe", { subscription: sub.toJSON(), label: deviceLabel(), app: appOfPath(location.pathname), categories, quiet });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (sub === null) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await call("DELETE", `/subscribe?endpoint=${encodeURIComponent(endpoint)}`);
}

export const minutesToTime = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const timeToMinutes = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
