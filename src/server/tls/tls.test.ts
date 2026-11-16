import { X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { readTlsConfig, validateTlsSetting } from "./config";
import { mobileConfig } from "./issue";
import { type TlsDeps, needsRenewal, realDeps, resolveTls, tailscaleState } from "./sources";

const DAY = 86_400_000;
const tmp = (): string => mkdtempSync(join(tmpdir(), "orch-tls-"));

function deps(over: Partial<TlsDeps> = {}): TlsDeps {
  return { which: () => null, run: async () => ({ code: 1, stdout: "", stderr: "" }), now: () => Date.now(), hostname: () => "testbox", ips: () => ["192.168.1.5"], ...over };
}

function fakeBin(dir: string, name: string, script: string): void {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
}

describe("config", () => {
  test("https is off by default and values are validated", () => {
    const home = tmp();
    expect(readTlsConfig(home, {}).httpsPort).toBe(0);
    writeFileSync(join(home, "serve.json"), JSON.stringify({ https_port: 6725, tls_mode: "localca", secure_link_hint: false }));
    const c = readTlsConfig(home, {});
    expect([c.httpsPort, c.mode, c.secureLinkHint]).toEqual([6725, "localca", false]);
    expect(validateTlsSetting("https_port", "70000")).not.toBeNull();
    expect(validateTlsSetting("https_port", "0")).toBeNull();
    expect(validateTlsSetting("tls_mode", "bogus")).not.toBeNull();
    expect(validateTlsSetting("tls_mode", "tailscale")).toBeNull();
    expect(validateTlsSetting("tls_cert", "relative")).not.toBeNull();
  });
});

describe("renewal threshold", () => {
  test("renews under 20 days with a fake clock", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(needsRenewal(new Date(now + 19 * DAY), now)).toBe(true);
    expect(needsRenewal(new Date(now + 21 * DAY), now)).toBe(false);
  });
});

describe("local CA", () => {
  test("CA and leaf carry the expected extensions and verify", async () => {
    const home = tmp();
    const cfg = readTlsConfig(home, {});
    const r = await resolveTls(home, { ...cfg, mode: "localca" }, deps());
    const m = r.material!;
    expect(m.source).toBe("localca");
    const leaf = new X509Certificate(m.cert);
    const ca = new X509Certificate(m.caPem!);
    expect(ca.subject).toContain("orch local CA testbox");
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    for (const n of ["localhost", "127.0.0.1", "::1", "testbox", "testbox.local", "192.168.1.5"]) expect(m.names).toContain(n);
    const days = (new Date(leaf.validTo).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThan(92);
    expect((new Date(ca.validTo).getTime() - Date.now()) / DAY).toBeGreaterThan(3600);
    const text = Bun.spawnSync(["openssl", "x509", "-noout", "-text", "-in", join(home, "tls/leaf.crt")]).stdout.toString();
    if (text !== "") {
      expect(text).toContain("TLS Web Server Authentication");
      expect(text).toContain("CA:FALSE");
      const caText = Bun.spawnSync(["openssl", "x509", "-noout", "-text", "-in", join(home, "tls/ca/ca.crt")]).stdout.toString();
      expect(caText).toMatch(/CA:TRUE, pathlen:0/);
      expect(caText).toContain("Certificate Sign");
      const v = Bun.spawnSync(["openssl", "verify", "-CAfile", join(home, "tls/ca/ca.crt"), join(home, "tls/leaf.crt")]);
      expect(v.exitCode).toBe(0);
    }
    expect(statSync(join(home, "tls/ca/ca.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "tls/leaf.key")).mode & 0o777).toBe(0o600);
  });

  test("the leaf is reused, then re-issued under the same CA when an IP appears", async () => {
    const home = tmp();
    const cfg = { ...readTlsConfig(home, {}), mode: "localca" as const };
    const a = (await resolveTls(home, cfg, deps())).material!;
    const again = (await resolveTls(home, cfg, deps())).material!;
    expect(again.cert).toBe(a.cert);
    const b = (await resolveTls(home, cfg, deps({ ips: () => ["192.168.1.5", "10.9.8.7"] }))).material!;
    expect(b.cert).not.toBe(a.cert);
    expect(b.names).toContain("10.9.8.7");
    expect(b.caFingerprint).toBe(a.caFingerprint);
    const late = (await resolveTls(home, cfg, deps({ now: () => Date.now() + 80 * DAY }))).material!;
    expect(late.cert).not.toBe(b.cert);
  });

  test("the iOS profile is a parseable plist with the CA payload and stable UUIDs", async () => {
    const home = tmp();
    const m = (await resolveTls(home, { ...readTlsConfig(home, {}), mode: "localca" }, deps())).material!;
    const a = mobileConfig(m.caPem!, "testbox");
    expect(a).toBe(mobileConfig(m.caPem!, "testbox"));
    expect(a).toContain("<string>com.apple.security.root</string>");
    expect(a).toContain("<string>Configuration</string>");
    const b64 = /<data>([^<]+)<\/data>/.exec(a)![1]!;
    expect(new X509Certificate(Buffer.from(b64, "base64")).fingerprint256).toBe(m.caFingerprint!);
    expect(a.match(/<key>PayloadUUID<\/key><string>([0-9A-F-]{36})<\/string>/g)?.length).toBe(2);
    const lint = Bun.spawnSync(["plutil", "-lint", "-"], { stdin: new TextEncoder().encode(a) });
    if (lint.exitCode !== 127 && lint.stdout.toString() !== "") expect(lint.exitCode).toBe(0);
  });
});

describe("self-signed", () => {
  test("a one-year self-issued certificate with the SANs", async () => {
    const home = tmp();
    const m = (await resolveTls(home, { ...readTlsConfig(home, {}), mode: "selfsigned" }, deps())).material!;
    const c = new X509Certificate(m.cert);
    expect(c.issuer).toBe(c.subject);
    expect(m.names).toContain("testbox.local");
    expect((new Date(c.validTo).getTime() - Date.now()) / DAY).toBeGreaterThan(360);
  });
});

describe("mode selection with fake binaries in PATH", () => {
  const original = process.env["PATH"];
  const withPath = async <T>(bin: string, fn: () => Promise<T>): Promise<T> => {
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
    try {
      return await fn();
    } finally {
      process.env["PATH"] = original;
    }
  };
  const status = (extra: string): string =>
    `if [ "$1" = status ]; then echo '{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net."}${extra}}'; exit 0; fi`;

  test("tailscale without CertDomains falls back to the local CA and says what to enable", async () => {
    const bin = tmp();
    fakeBin(bin, "tailscale", status(',"CertDomains":null'));
    const home = tmp();
    const r = await withPath(bin, () => resolveTls(home, readTlsConfig(home, {}), realDeps()));
    expect(r.material?.source).toBe("localca");
    expect(r.material?.names).toContain("box.tail1.ts.net");
    expect(r.problems.join(" ")).toContain("Enable HTTPS Certificates in the Tailscale admin console");
    const st = await withPath(bin, () => tailscaleState(realDeps()));
    expect(st.certsEnabled).toBe(false);
  });

  test("tailscale with certificates enabled runs `tailscale cert` and wins in auto", async () => {
    const bin = tmp();
    const donor = await resolveTls(tmp(), { ...readTlsConfig(tmp(), {}), mode: "selfsigned" }, deps());
    const donorDir = tmp();
    writeFileSync(join(donorDir, "c"), donor.material!.cert);
    writeFileSync(join(donorDir, "k"), donor.material!.key);
    fakeBin(
      bin,
      "tailscale",
      `${status(',"CertDomains":["box.tail1.ts.net"]')}\nif [ "$1" = cert ]; then cp ${donorDir}/c "$3"; cp ${donorDir}/k "$5"; echo "$6" > ${donorDir}/name; exit 0; fi`,
    );
    const home = tmp();
    const r = await withPath(bin, () => resolveTls(home, readTlsConfig(home, {}), realDeps()));
    expect(r.material?.source).toBe("tailscale");
    expect(readFileSync(join(donorDir, "name"), "utf8").trim()).toBe("box.tail1.ts.net");
    expect(statSync(join(home, "tls/tailscale.key")).mode & 0o777).toBe(0o600);
  });

  test("mkcert is used only with an existing CA, and tls_mode mkcert without one reports it", async () => {
    const bin = tmp();
    const root = tmp();
    fakeBin(bin, "mkcert", `if [ "$1" = -CAROOT ]; then echo ${root}; exit 0; fi; exit 1`);
    const home = tmp();
    const cfg = { ...readTlsConfig(home, {}), mode: "mkcert" as const };
    const r = await withPath(bin, () => resolveTls(home, cfg, realDeps()));
    expect(r.material).toBeNull();
    expect(r.problem).toContain("mkcert -install");
  });
});
