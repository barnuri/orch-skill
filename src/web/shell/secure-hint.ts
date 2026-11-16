export const SECURE_HINT_EVENT = "orch:secure-context-needed";
export const SECURE_HINT_DISMISS_KEY = "orch.secureLinkHint.dismissed";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True on a plain-HTTP page that is not on this machine: the only place a secure context is missing for a reason the user can fix. */
export function needsSecureContext(loc: { protocol: string; hostname: string }): boolean {
  return loc.protocol === "http:" && !LOCAL_HOSTS.has(loc.hostname.toLowerCase());
}

/** Whether the quiet hint should show: setting on, not dismissed, a secure-context feature was attempted, https answers. */
export function showSecureHint(input: {
  loc: { protocol: string; hostname: string };
  attempted: boolean;
  dismissed: boolean;
  hintEnabled: boolean;
  httpsUrl: string | null;
}): boolean {
  return input.attempted && !input.dismissed && input.hintEnabled && input.httpsUrl !== null && needsSecureContext(input.loc);
}

/** A rejection or error that comes from using the microphone or clipboard without a secure context. */
export function looksLikeInsecureFeature(message: string): boolean {
  return /mediaDevices|getUserMedia|navigator\.clipboard|clipboard/i.test(message) && /undefined|secure|not allowed|denied|insecure/i.test(message);
}

/** Fire this from a feature (microphone button, clipboard) when it needs a secure context and has none. */
export function notifySecureContextNeeded(): void {
  window.dispatchEvent(new Event(SECURE_HINT_EVENT));
}

export function isDismissed(): boolean {
  try {
    return localStorage.getItem(SECURE_HINT_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberDismissed(): void {
  try {
    localStorage.setItem(SECURE_HINT_DISMISS_KEY, "1");
  } catch {
    // private mode: the hint just comes back next load
  }
}
