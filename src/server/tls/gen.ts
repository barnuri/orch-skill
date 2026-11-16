import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import { type Keyed, type San } from "./issue";

const DAY_MS = 86_400_000;

const EC: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGN: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
const CA_DAYS = 3650;

function pemOf(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function keyPem(key: CryptoKey): Promise<string> {
  return pemOf("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", key));
}

function serial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return Buffer.from(bytes).toString("hex");
}

function sanExtension(sans: readonly San[]): x509.SubjectAlternativeNameExtension {
  return new x509.SubjectAlternativeNameExtension(sans.map((s) => ({ type: s.type, value: s.value })));
}

export async function createCa(hostname: string, now: number): Promise<Keyed> {
  const keys = (await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=orch local CA ${hostname}`,
    issuer: `CN=orch local CA ${hostname}`,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + CA_DAYS * DAY_MS),
    signingAlgorithm: SIGN,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await keyPem(keys.privateKey) };
}

/** A leaf signed by `ca`, or self-signed when `ca` is null (CA:false either way). */
export async function createLeaf(opts: {
  ca: Keyed | null;
  commonName: string;
  sans: readonly San[];
  days: number;
  now: number;
}): Promise<Keyed> {
  const keys = (await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
  const caCert = opts.ca === null ? null : new x509.X509Certificate(opts.ca.certPem);
  const signingKey =
    opts.ca === null
      ? keys.privateKey
      : await crypto.subtle.importKey("pkcs8", Buffer.from(opts.ca.keyPem.replace(/-----[^-]+-----|\s/g, ""), "base64"), EC, false, ["sign"]);
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
    sanExtension(opts.sans),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
  ];
  if (caCert !== null) {
    extensions.push(await x509.AuthorityKeyIdentifierExtension.create(caCert, false));
  }
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${opts.commonName}`,
    issuer: caCert === null ? `CN=${opts.commonName}` : caCert.subject,
    notBefore: new Date(opts.now - DAY_MS),
    notAfter: new Date(opts.now + opts.days * DAY_MS),
    signingAlgorithm: SIGN,
    publicKey: keys.publicKey,
    signingKey,
    extensions,
  });
  return { certPem: cert.toString("pem"), keyPem: await keyPem(keys.privateKey) };
}

