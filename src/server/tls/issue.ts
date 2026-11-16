import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LEAF_DAYS = 90;
export const SELF_SIGNED_DAYS = 365;

export interface Keyed {
  certPem: string;
  keyPem: string;
}

export interface San {
  type: "dns" | "ip";
  value: string;
}

/** One spelling per name: IPv6 compressed and lower-case, so a certificate's SAN text compares with a wanted name. */
export function normName(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v.includes(":")) return v;
  try {
    return new URL(`http://[${v.replace(/^\[|\]$/g, "")}]`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return v;
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function sanList(names: readonly string[]): San[] {
  const seen = new Set<string>();
  const out: San[] = [];
  for (const n of names) {
    const value = normName(n);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push({ type: IPV4.test(value) || value.includes(":") ? "ip" : "dns", value });
  }
  return out;
}

export function writeSecret(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function writePublic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o644 });
}

export function readIf(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function parseCert(pem: string): X509Certificate | null {
  try {
    return new X509Certificate(pem);
  } catch {
    return null;
  }
}

/** DNS and IP names a certificate covers, as lower-case strings. */
export function certNames(cert: X509Certificate): string[] {
  const text = cert.subjectAltName ?? "";
  return text
    .split(",")
    .map((p) => p.trim())
    .map((p) => (p.startsWith("DNS:") ? p.slice(4) : p.startsWith("IP Address:") ? p.slice(11) : ""))
    .filter((p) => p !== "")
    .map(normName);
}

export const fingerprintOf = (cert: X509Certificate): string => cert.fingerprint256;

export function derOf(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
}

/** A stable UUID derived from a seed, so a regenerated profile of the same CA keeps its identity. */
export function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

export function mobileConfig(caPem: string, hostname: string): string {
  const der = derOf(caPem).toString("base64");
  const fp = parseCert(caPem)?.fingerprint256 ?? hostname;
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const name = `orch local CA ${hostname}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>orch-local-ca.crt</string>
      <key>PayloadContent</key><data>${der}</data>
      <key>PayloadDescription</key><string>Trusts the orch dashboard on ${esc(hostname)}</string>
      <key>PayloadDisplayName</key><string>${esc(name)}</string>
      <key>PayloadIdentifier</key><string>io.github.barnuri.orch.ca.root</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${stableUuid(`payload:${fp}`)}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Installs the orch local certificate authority</string>
  <key>PayloadDisplayName</key><string>${esc(name)}</string>
  <key>PayloadIdentifier</key><string>io.github.barnuri.orch.ca</string>
  <key>PayloadOrganization</key><string>orch</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${stableUuid(`profile:${fp}`)}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}
