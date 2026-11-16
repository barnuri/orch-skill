import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { join } from "node:path";

import { type TlsConfig, tlsDir } from "./config";
import {
  LEAF_DAYS,
  SELF_SIGNED_DAYS,
  certNames,
  fingerprintOf,
  normName,
  parseCert,
  readIf,
  sanList,
  writePublic,
  writeSecret,
} from "./issue";

const DAY_MS = 86_400_000;
export const RENEW_DAYS = 20;

export type TlsSource = "tailscale" | "mkcert" | "localca" | "selfsigned" | "files";

export interface TlsMaterial {
  cert: string;
  key: string;
  source: TlsSource;
  notAfter: Date;
  names: string[];
  /** Public PEM of the CA a device must trust; null for tailscale (already trusted) and files. */
  caPem: string | null;
  caFingerprint: string | null;
}

export interface Probe {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TlsDeps {
  which(name: string): string | null;
  run(cmd: string[]): Promise<Probe>;
  now(): number;
  hostname(): string;
  ips(): string[];
}

export function realDeps(): TlsDeps {
  return {
    which: (name) => Bun.which(name, { PATH: process.env["PATH"] ?? "" }),
    run: async (cmd) => {
      try {
        const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, stdout, stderr };
      } catch (e) {
        return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
      }
    },
    now: () => Date.now(),
    hostname: () => osHostname(),
    ips: () => {
      const found: string[] = [];
      for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) {
          if (!a.address.startsWith("fe80")) found.push(a.address);
        }
      }
      return found;
    },
  };
}

export function needsRenewal(notAfter: Date, nowMs: number, days: number = RENEW_DAYS): boolean {
  return notAfter.getTime() - nowMs < days * DAY_MS;
}

export interface Outcome {
  material: TlsMaterial | null;
  /** One plain sentence for the user when the mode could not produce a certificate. */
  problem: string | null;
}

const TS_ENABLE =
  "Enable HTTPS Certificates in the Tailscale admin console (DNS page), then run `dispatch.ts serve tls renew`.";

export interface TailscaleState {
  name: string | null;
  certsEnabled: boolean;
  problem: string | null;
}

export async function tailscaleState(deps: TlsDeps): Promise<TailscaleState> {
  const bin = deps.which("tailscale");
  if (bin === null) return { name: null, certsEnabled: false, problem: "tailscale is not installed" };
  const r = await deps.run([bin, "status", "--json"]);
  if (r.code !== 0) return { name: null, certsEnabled: false, problem: "tailscale is not logged in or not running" };
  try {
    const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
    if (j.BackendState !== "Running") return { name: null, certsEnabled: false, problem: "tailscale is not logged in or not running" };
    const name = (j.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    if (name === "") return { name: null, certsEnabled: false, problem: "tailscale reports no MagicDNS name" };
    const enabled = (j.CertDomains ?? []).map((d) => d.toLowerCase()).includes(name);
    return { name, certsEnabled: enabled, problem: enabled ? null : TS_ENABLE };
  } catch {
    return { name: null, certsEnabled: false, problem: "tailscale status output was not readable" };
  }
}

function localNames(deps: TlsDeps, extra: string[]): string[] {
  const host = deps.hostname().toLowerCase();
  const short = host.split(".")[0] ?? host;
  return ["localhost", "127.0.0.1", "::1", host, short, `${short}.local`, ...extra, ...deps.ips()];
}

function material(cert: string, key: string, source: TlsSource, caPem: string | null): TlsMaterial | null {
  const c = parseCert(cert);
  if (c === null) return null;
  const ca = caPem === null ? null : parseCert(caPem);
  return {
    cert,
    key,
    source,
    notAfter: new Date(c.validTo),
    names: certNames(c),
    caPem,
    caFingerprint: ca === null ? null : fingerprintOf(ca),
  };
}

function reusable(cert: string | null, nowMs: number, needed: readonly string[]): X509Certificate | null {
  if (cert === null) return null;
  const c = parseCert(cert);
  if (c === null || needsRenewal(new Date(c.validTo), nowMs)) return null;
  const have = new Set(certNames(c));
  return needed.every((n) => have.has(normName(n))) ? c : null;
}

async function tailscale(home: string, deps: TlsDeps, force: boolean): Promise<Outcome> {
  const st = await tailscaleState(deps);
  if (st.name === null || !st.certsEnabled) return { material: null, problem: st.problem };
  const dir = tlsDir(home);
  const certFile = join(dir, "tailscale.crt");
  const keyFile = join(dir, "tailscale.key");
  const have = readIf(certFile);
  const key = readIf(keyFile);
  if (!force && key !== null && reusable(have, deps.now(), [st.name]) !== null) {
    return { material: material(have as string, key, "tailscale", null), problem: null };
  }
  writeSecret(keyFile, key ?? "");
  const r = await deps.run([deps.which("tailscale") as string, "cert", "--cert-file", certFile, "--key-file", keyFile, st.name]);
  if (r.code !== 0) return { material: null, problem: `tailscale cert failed: ${r.stderr.trim().split("\n")[0] ?? ""}`.trim() };
  const cert = readIf(certFile);
  const k = readIf(keyFile);
  if (cert === null || k === null) return { material: null, problem: "tailscale cert wrote no files" };
  writeSecret(keyFile, k);
  const m = material(cert, k, "tailscale", null);
  return m === null ? { material: null, problem: "tailscale cert wrote an unreadable certificate" } : { material: m, problem: null };
}

async function mkcert(home: string, deps: TlsDeps, force: boolean, extra: string[]): Promise<Outcome> {
  const bin = deps.which("mkcert");
  if (bin === null) return { material: null, problem: "mkcert is not installed" };
  const root = await deps.run([bin, "-CAROOT"]);
  const caFile = join(root.stdout.trim(), "rootCA.pem");
  if (root.code !== 0 || !existsSync(caFile)) {
    return { material: null, problem: "mkcert has no local CA yet; run `mkcert -install` once" };
  }
  const names = [...new Set(localNames(deps, extra))];
  const dir = tlsDir(home);
  const certFile = join(dir, "mkcert.crt");
  const keyFile = join(dir, "mkcert.key");
  const caPem = readFileSync(caFile, "utf8");
  const have = readIf(certFile);
  const key = readIf(keyFile);
  if (!force && key !== null && reusable(have, deps.now(), names) !== null) {
    return { material: material(have as string, key, "mkcert", caPem), problem: null };
  }
  writeSecret(keyFile, "");
  const r = await deps.run([bin, "-cert-file", certFile, "-key-file", keyFile, ...names]);
  if (r.code !== 0) return { material: null, problem: `mkcert failed: ${r.stderr.trim().split("\n")[0] ?? ""}`.trim() };
  const cert = readIf(certFile);
  const k = readIf(keyFile);
  if (cert === null || k === null) return { material: null, problem: "mkcert wrote no files" };
  writeSecret(keyFile, k);
  const m = material(cert, k, "mkcert", caPem);
  return m === null ? { material: null, problem: "mkcert wrote an unreadable certificate" } : { material: m, problem: null };
}

export async function ensureCa(home: string, deps: TlsDeps): Promise<{ certPem: string; keyPem: string }> {
  const dir = join(tlsDir(home), "ca");
  const certFile = join(dir, "ca.crt");
  const keyFile = join(dir, "ca.key");
  const c = readIf(certFile);
  const k = readIf(keyFile);
  if (c !== null && k !== null && parseCert(c) !== null) return { certPem: c, keyPem: k };
  const { createCa } = await import("./gen");
  const made = await createCa(deps.hostname(), deps.now());
  writeSecret(keyFile, made.keyPem);
  writePublic(certFile, made.certPem);
  return made;
}

async function localca(home: string, deps: TlsDeps, force: boolean, extra: string[]): Promise<Outcome> {
  const names = [...new Set(localNames(deps, extra))];
  const ca = await ensureCa(home, deps);
  const dir = tlsDir(home);
  const certFile = join(dir, "leaf.crt");
  const keyFile = join(dir, "leaf.key");
  const have = readIf(certFile);
  const key = readIf(keyFile);
  if (!force && key !== null && reusable(have, deps.now(), names) !== null && issuedBy(have as string, ca.certPem)) {
    return { material: material(have as string, key, "localca", ca.certPem), problem: null };
  }
  const { createLeaf } = await import("./gen");
  const leaf = await createLeaf({ ca, commonName: deps.hostname(), sans: sanList(names), days: LEAF_DAYS, now: deps.now() });
  writeSecret(keyFile, leaf.keyPem);
  writePublic(certFile, leaf.certPem);
  return { material: material(leaf.certPem, leaf.keyPem, "localca", ca.certPem), problem: null };
}

function issuedBy(leafPem: string, caPem: string): boolean {
  const leaf = parseCert(leafPem);
  const ca = parseCert(caPem);
  return leaf !== null && ca !== null && leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
}

async function selfsigned(home: string, deps: TlsDeps, force: boolean, extra: string[]): Promise<Outcome> {
  const names = [...new Set(localNames(deps, extra))];
  const dir = tlsDir(home);
  const certFile = join(dir, "selfsigned.crt");
  const keyFile = join(dir, "selfsigned.key");
  const have = readIf(certFile);
  const key = readIf(keyFile);
  if (!force && key !== null && reusable(have, deps.now(), names) !== null) {
    return { material: material(have as string, key, "selfsigned", null), problem: null };
  }
  const { createLeaf } = await import("./gen");
  const leaf = await createLeaf({ ca: null, commonName: deps.hostname(), sans: sanList(names), days: SELF_SIGNED_DAYS, now: deps.now() });
  writeSecret(keyFile, leaf.keyPem);
  writePublic(certFile, leaf.certPem);
  return { material: material(leaf.certPem, leaf.keyPem, "selfsigned", null), problem: null };
}

function files(cfg: TlsConfig): Outcome {
  if (cfg.certFile === "" || cfg.keyFile === "") return { material: null, problem: "tls_mode files needs tls_cert and tls_key" };
  const cert = readIf(cfg.certFile);
  const key = readIf(cfg.keyFile);
  if (cert === null || key === null) return { material: null, problem: "tls_cert or tls_key cannot be read" };
  const m = material(cert, key, "files", null);
  return m === null ? { material: null, problem: "tls_cert is not a readable certificate" } : { material: m, problem: null };
}

/**
 * Picks the certificate for the configured mode. `auto` tries tailscale, then mkcert, then the local CA.
 * Generation is lazy: nothing is created until the HTTPS listener asks. `problems` keeps one sentence per
 * route that was tried and failed, so status can say why a better route was not used.
 */
export async function resolveTls(
  home: string,
  cfg: TlsConfig,
  deps: TlsDeps = realDeps(),
  opts: { force?: boolean } = {},
): Promise<Outcome & { problems: string[] }> {
  const force = opts.force === true;
  const extra: string[] = [];
  const problems: string[] = [];
  const attempt = async (name: string, fn: () => Promise<Outcome> | Outcome): Promise<Outcome> => {
    try {
      const o = await fn();
      if (o.problem !== null) problems.push(`${name}: ${o.problem}`);
      return o;
    } catch (e) {
      const p = `${name}: ${e instanceof Error ? e.message : String(e)}`;
      problems.push(p);
      return { material: null, problem: p };
    }
  };
  const ts = await tailscaleState(deps);
  if (ts.name !== null) extra.push(ts.name);
  const order: Array<[string, () => Promise<Outcome> | Outcome]> = [];
  const run = {
    tailscale: () => tailscale(home, deps, force),
    mkcert: () => mkcert(home, deps, force, extra),
    localca: () => localca(home, deps, force, extra),
    selfsigned: () => selfsigned(home, deps, force, extra),
    files: () => files(cfg),
  };
  if (cfg.mode === "auto") order.push(["tailscale", run.tailscale], ["mkcert", run.mkcert], ["localca", run.localca]);
  else order.push([cfg.mode, run[cfg.mode]]);
  for (const [name, fn] of order) {
    const o = await attempt(name, fn);
    if (o.material !== null) return { ...o, problems };
  }
  return { material: null, problem: problems[problems.length - 1] ?? "no certificate source", problems };
}
