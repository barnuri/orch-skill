import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { buildApp, startHttpsServer, startServer } from "../app";
import { digestToken } from "../http/auth";
import { ensureHome } from "../files/ensure-home";
import type { ServerOptions } from "../types/server-options";
import { readTlsConfig } from "./config";
import { TlsManager } from "./manager";
import { formatHttpsLine } from "./status-file";
import { realDeps } from "./sources";

const TOKEN = "t0ken";
const home = mkdtempSync(join(tmpdir(), "orch-tls-srv-"));
ensureHome(home, resolve(import.meta.dir, "../../../skills/orch/templates"));

const cfg = { ...readTlsConfig(home, {}), httpsPort: 1, mode: "localca" as const };
const manager = new TlsManager(home, cfg, () => {}, { ...realDeps(), hostname: () => "testbox", ips: () => ["192.168.1.5"] });
const material = (await manager.load())!;

const options: ServerOptions = {
  home,
  host: "127.0.0.1",
  port: 0,
  tokenDigest: digestToken(TOKEN),
  requireToken: true,
  requireRemoteToken: true,
  harnesses: ["claude"],
  outcomes: ["success"],
  tls: manager,
  httpsPort: 1,
};
const api = buildApp(options);
const http = startServer(options, api);
const https = startHttpsServer(options, 0, { cert: material.cert, key: material.key }, api);
manager.setListening(true);
const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
const get = (base: string, path: string, auth = true): Promise<Response> =>
  fetch(`${base}${path}`, { ...insecure, headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
const H = `http://127.0.0.1:${http.port}`;
const S = `https://127.0.0.1:${https.port}`;

afterAll(async () => {
  await http.stop(true);
  await https.stop(true);
});

describe("two listeners, one app", () => {
  test("both answer the same route with the same auth rules", async () => {
    for (const base of [H, S]) {
      expect((await get(base, "/api/health")).status).toBe(200);
      expect((await get(base, "/api/health", false)).status).toBe(401);
      expect((await get(base, "/chat", false)).status).toBe(200);
    }
  });

  test("/ca.crt, /ca.mobileconfig and /trust need no token and expose only the public CA", async () => {
    for (const base of [H, S]) {
      const crt = await get(base, "/ca.crt", false);
      expect(crt.headers.get("content-type")).toBe("application/x-x509-ca-cert");
      const pem = await crt.text();
      expect(new X509Certificate(pem).fingerprint256).toBe(material.caFingerprint!);
      expect(pem).not.toContain("PRIVATE");
      const mc = await get(base, "/ca.mobileconfig", false);
      expect(mc.status).toBe(200);
      expect(await mc.text()).toContain("com.apple.security.root");
      const trust = await get(base, "/trust", false);
      const html = await trust.text();
      expect(trust.status).toBe(200);
      expect(html).toContain("Settings &gt; Profile Downloaded");
      expect(html).toContain("Install a certificate");
      expect(html).toContain("<svg");
      expect(html).toContain(material.caFingerprint!);
    }
  });

  test("no route response carries a private key, no upgrade-insecure-requests, no cookie, no redirect", async () => {
    for (const path of ["/", "/chat", "/trust", "/ca.crt", "/ca.mobileconfig", "/api/server-info", "/api/openapi.json", "/api/health"]) {
      for (const base of [H, S]) {
        const r = await fetch(`${base}${path}`, { ...insecure, redirect: "manual", headers: { authorization: `Bearer ${TOKEN}` } });
        const text = await r.text();
        expect(text).not.toContain("PRIVATE KEY");
        expect(r.headers.get("set-cookie")).toBeNull();
        expect(r.headers.get("strict-transport-security")).toBeNull();
        expect(`${r.headers.get("content-security-policy")} ${text}`).not.toContain("upgrade-insecure-requests");
        expect(r.status).toBeLessThan(300);
      }
    }
  });

  test("the static web files hold no private key", () => {
    const stack = [resolve(import.meta.dir, "../../web"), resolve(import.meta.dir, "../../snapshot")];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) stack.push(p);
        else if (!/\.(png|woff2?|ico)$/.test(name)) expect(readFileSync(p, "utf8")).not.toContain("PRIVATE KEY");
      }
    }
  });

  test("/api/server-info reports the secure link and trust page", async () => {
    const body = (await (await get(H, "/api/server-info")).json()) as Record<string, unknown>;
    expect(body["https_listening"]).toBe(true);
    expect(body["https_url"]).toBe(`https://127.0.0.1:1/`);
    expect(body["trust_path"]).toBe("/trust");
    expect(body["cert_source"]).toBe("localca");
    expect(body["secure_link_hint"]).toBe(true);
  });
});

describe("HTTPS is optional and never takes the HTTP listener down", () => {
  test("a broken certificate throws only from the HTTPS start", async () => {
    expect(() => startHttpsServer(options, 0, { cert: "garbage", key: "garbage" }, api)).toThrow();
    expect((await get(H, "/api/health")).status).toBe(200);
  });

  test("without tls the server-info route says https is off and the trust routes are 404", async () => {
    const plain = { ...options, tls: undefined, httpsPort: 0 } as ServerOptions;
    const s = startServer(plain);
    try {
      const body = (await (await get(`http://127.0.0.1:${s.port}`, "/api/server-info")).json()) as Record<string, unknown>;
      expect([body["https_port"], body["https_url"], body["https_listening"]]).toEqual([0, null, false]);
      expect((await get(`http://127.0.0.1:${s.port}`, "/ca.crt", false)).status).toBe(404);
    } finally {
      await s.stop(true);
    }
  });
});

describe("status line", () => {
  test("off, up with source and expiry, and down with a reason", () => {
    expect(formatHttpsLine(null, 0, "box")).toBe("https: off");
    const up = formatHttpsLine(manager.status(), 6725, "box");
    expect(up).toContain("https://box:1/");
    expect(up).toContain("cert: localca");
    expect(up).toContain("expires 20");
    expect(formatHttpsLine({ ...manager.status(), listening: false, problem: "cannot bind HTTPS port 6725: EADDRINUSE" }, 6725, "box")).toContain("EADDRINUSE");
    expect(formatHttpsLine({ ...manager.status(), source: "selfsigned", warning: "self-signed: browsers warn once" }, 6725, "box")).toContain("self-signed: browsers warn once");
  });
});

describe("HTTP stays the default for every internal caller", () => {
  test("no source file builds an https URL to this machine", () => {
    const roots = [resolve(import.meta.dir, "../.."), resolve(import.meta.dir, "../../../scripts"), resolve(import.meta.dir, "../../../skills")];
    const bad: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|sh|json)$/.test(name) && !/\.test\./.test(name) && /https:\/\/(127\.0\.0\.1|localhost)/.test(readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    roots.forEach(walk);
    expect(bad).toEqual([]);
  });
});
