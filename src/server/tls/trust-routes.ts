import qrcode from "qrcode-generator";

import { hostAllowed } from "../http/host-policy";
import { mobileConfig } from "./issue";
import { type TlsRuntime, secureHostFor } from "./manager";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TRUST_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export function qrSvg(text: string): string {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export interface TrustContext {
  tls: TlsRuntime | undefined;
  hostname: string;
  bindHost: string;
}

export function caCrtResponse(ctx: TrustContext): Response {
  const pem = ctx.tls?.caPem() ?? null;
  if (pem === null) return plain(404, "no local CA in use\n");
  return new Response(pem, {
    headers: { "content-type": "application/x-x509-ca-cert", "content-disposition": 'attachment; filename="orch-local-ca.crt"', "cache-control": "no-store" },
  });
}

export function mobileConfigResponse(ctx: TrustContext): Response {
  const pem = ctx.tls?.caPem() ?? null;
  if (pem === null) return plain(404, "no local CA in use\n");
  return new Response(mobileConfig(pem, ctx.hostname), {
    headers: { "content-type": "application/x-apple-aspen-config", "content-disposition": 'attachment; filename="orch-local-ca.mobileconfig"', "cache-control": "no-store" },
  });
}

/** Plain steps per device, plus a QR of the https URL. Needs no token: it exposes only the public CA. */
export function trustPageResponse(ctx: TrustContext, req: Request): Response {
  const status = ctx.tls?.status();
  const hostHeader = req.headers.get("host");
  const reqHost = hostHeader !== null && hostAllowed(hostHeader, ctx.bindHost, ctx.hostname) ? hostHeader.replace(/:\d+$/, "") : ctx.hostname;
  const url = status !== undefined && status.enabled ? `https://${secureHostFor(status.names, reqHost)}:${status.port}/` : null;
  const hasCa = ctx.tls?.caPem() != null;
  const fp = status?.ca_fingerprint ?? null;
  const steps = hasCa
    ? `<h2>iPhone or iPad</h2><ol><li>Open <a href="/ca.mobileconfig">/ca.mobileconfig</a> in Safari and tap Allow.</li><li>Settings &gt; Profile Downloaded &gt; Install.</li><li>Settings &gt; General &gt; About &gt; Certificate Trust Settings &gt; turn on full trust for the orch local CA.</li></ol>
<h2>Android</h2><ol><li>Download <a href="/ca.crt">/ca.crt</a>.</li><li>Settings &gt; Security &gt; Encryption and credentials &gt; Install a certificate &gt; CA certificate. Confirm the warning.</li><li>Pick the downloaded file.</li></ol>
<h2>macOS</h2><ol><li>Download <a href="/ca.crt">/ca.crt</a> and open it; Keychain Access opens.</li><li>Add it to the System keychain, double-click it, open Trust and set "Always Trust".</li></ol>
<h2>Windows</h2><ol><li>Download <a href="/ca.crt">/ca.crt</a>, open it, choose Install Certificate &gt; Local Machine.</li><li>Place it in "Trusted Root Certification Authorities".</li></ol>
<p>Trust it once per device. Later certificates from this machine need no step.${fp === null ? "" : ` CA fingerprint (SHA-256), to compare on the device: <code>${esc(fp)}</code>`}</p>`
    : "<p>This server uses a certificate that needs no step on your device (or HTTPS is off), so there is no CA to install.</p>";
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Trust the orch certificate</title>
<style>body{font:16px/1.5 system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}code{word-break:break-all}svg{width:12rem;height:12rem;background:#fff}</style>
<h1>Trust the orch certificate</h1>
${url === null ? "<p>The HTTPS port is off. Run <code>dispatch.ts serve config https_port on</code> and restart.</p>" : `<p>Secure link: <a href="${esc(url)}">${esc(url)}</a></p>${qrSvg(url)}`}
${steps}</html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TRUST_CSP, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
