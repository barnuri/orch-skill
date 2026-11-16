import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TLS_MODES = ["auto", "tailscale", "mkcert", "localca", "selfsigned", "files"] as const;
export type TlsMode = (typeof TLS_MODES)[number];

/** The port `https_port on` selects. HTTPS is opt-in: a missing key means off (0). */
export const DEFAULT_HTTPS_PORT = 6725;
export const MAX_PORT = 65535;

export interface TlsConfig {
  /** 0 disables the HTTPS listener. */
  httpsPort: number;
  mode: TlsMode;
  certFile: string;
  keyFile: string;
  /** Whether the quiet "open the secure link" hint may show. */
  secureLinkHint: boolean;
}

export const TLS_CONFIG_KEYS = ["https_port", "tls_mode", "tls_cert", "tls_key", "secure_link_hint"] as const;

/** Returns an error sentence, or null when `value` is acceptable for the serve.json key. */
export function validateTlsSetting(key: string, value: string): string | null {
  if (key === "https_port") {
    return /^\d+$/.test(value) && Number(value) <= MAX_PORT ? null : `https_port expects 0-${MAX_PORT} (0 disables HTTPS)`;
  }
  if (key === "secure_link_hint") {
    return ["true", "false", "1", "0"].includes(value) ? null : "secure_link_hint expects true or false";
  }
  if (key === "tls_mode") {
    return (TLS_MODES as readonly string[]).includes(value) ? null : `tls_mode expects one of: ${TLS_MODES.join(", ")}`;
  }
  if (key === "tls_cert" || key === "tls_key") {
    return value === "" || value.startsWith("/") || value.startsWith("~") ? null : `${key} expects an absolute path`;
  }
  return `unknown key ${key}`;
}

export function tlsDir(home: string): string {
  return join(home, "tls");
}

/** Reads the TLS keys of serve.json. Bad values fall back to the defaults, so a typo never stops the server. */
export function readTlsConfig(home: string, env: Record<string, string | undefined> = process.env): TlsConfig {
  let raw: Record<string, unknown> = {};
  const file = join(home, "serve.json");
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  const pick = (key: string, fallback: string): string => {
    const v = raw[key];
    return v === undefined || v === null ? fallback : String(v);
  };
  const portText = env["ORCH_HTTPS_PORT"] ?? pick("https_port", "0");
  const modeText = pick("tls_mode", "auto");
  return {
    httpsPort: validateTlsSetting("https_port", portText) === null ? Number(portText) : 0,
    mode: validateTlsSetting("tls_mode", modeText) === null ? (modeText as TlsMode) : "auto",
    certFile: pick("tls_cert", ""),
    keyFile: pick("tls_key", ""),
    secureLinkHint: !["false", "0"].includes(pick("secure_link_hint", "true")),
  };
}
