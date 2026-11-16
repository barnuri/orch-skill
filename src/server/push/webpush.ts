import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CATEGORY_TTL_S, CATEGORY_URGENCY, type PushCategory } from "../../shared/push";

const enc = new TextEncoder();
const subtle = crypto.subtle;

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromB64u = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));

// ---------- VAPID (RFC 8292) ----------

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: the `applicationServerKey` the browser subscribes with. */
  public_key: string;
  private_jwk: JsonWebKey;
  subject: string;
}

export function vapidPath(home: string): string {
  return join(home, "push", "vapid.json");
}

export async function generateVapid(subject = "mailto:orch@example.com"): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { public_key: b64u(raw), private_jwk: await subtle.exportKey("jwk", pair.privateKey), subject };
}

/** Generated once, kept 0600 under `<home>/push/vapid.json`. The private key is never served. */
export async function loadOrCreateVapid(home: string): Promise<VapidKeys> {
  const file = vapidPath(home);
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
      if (typeof v.public_key === "string" && v.private_jwk?.d !== undefined) return v;
    } catch {
      // unreadable: fall through and make a new pair (old subscriptions then need to resubscribe)
    }
  }
  const keys = await generateVapid();
  mkdirSync(join(home, "push"), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}

export async function vapidJwt(keys: VapidKeys, audience: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: audience, exp: nowS + 12 * 3600, sub: keys.subject })));
  const key = await subtle.importKey("jwk", keys.private_jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`) as BufferSource));
  return `${head}.${claims}.${b64u(sig)}`;
}

export async function verifyVapidJwt(jwt: string, publicKey: string): Promise<{ aud: string; exp: number; sub: string } | null> {
  const [h, c, s] = jwt.split(".");
  if (h === undefined || c === undefined || s === undefined) return null;
  const key = await subtle.importKey("raw", fromB64u(publicKey) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64u(s) as BufferSource, enc.encode(`${h}.${c}`) as BufferSource);
  return ok ? (JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { aud: string; exp: number; sub: string }) : null;
}

// ---------- Message encryption (RFC 8291, aes128gcm of RFC 8188) ----------

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
}

const importPublic = (raw: Uint8Array): Promise<CryptoKey> => subtle.importKey("raw", raw as BufferSource, { name: "ECDH", namedCurve: "P-256" }, true, []);

async function contentKeys(ecdh: Uint8Array, auth: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  return {
    cek: await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16),
    nonce: await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12),
  };
}

export interface EncryptOptions {
  salt?: Uint8Array;
  /** Test seam: the application server's ephemeral key pair (the RFC's example values). */
  asKeyPair?: CryptoKeyPair;
}

/** One-record aes128gcm body: header (salt, rs, keyid = as_public) then the ciphertext. */
export async function encryptPayload(plaintext: Uint8Array, uaPublicB64: string, authB64: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = fromB64u(uaPublicB64);
  const auth = fromB64u(authB64);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const pair = opts.asKeyPair ?? ((await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await importPublic(uaPublic) }, pair.privateKey, 256));
  const { cek, nonce } = await contentKeys(ecdh, auth, uaPublic, asPublic, salt);
  const key = await subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const body = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(plaintext, new Uint8Array([2])) as BufferSource));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, body);
}

/** The user agent's side, used by tests to prove the round trip. */
export async function decryptPayload(body: Uint8Array, uaPrivate: CryptoKey, uaPublicB64: string, authB64: string): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await importPublic(asPublic) }, uaPrivate, 256));
  const { cek, nonce } = await contentKeys(ecdh, fromB64u(authB64), fromB64u(uaPublicB64), asPublic, salt);
  const key = await subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, ct as BufferSource));
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  return plain.slice(0, end - 1);
}

// ---------- Sending ----------

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendResult = { ok: true; status: number } | { ok: false; status: number; gone: boolean; error: string };

/** Push endpoints are the browser vendors' https services. Plain http is accepted for a loopback mock only. */
export function endpointAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export interface SendOptions {
  category: PushCategory;
  topic?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function sendPush(keys: VapidKeys, target: PushTarget, payload: unknown, opts: SendOptions): Promise<SendResult> {
  if (!endpointAllowed(target.endpoint)) return { ok: false, status: 0, gone: false, error: "endpoint is not an https push service" };
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const backoff = opts.backoffMs ?? [1000, 4000];
  let body: Uint8Array;
  try {
    body = await encryptPayload(enc.encode(JSON.stringify(payload)), target.p256dh, target.auth);
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: `bad subscription keys: ${err instanceof Error ? err.message : String(err)}` };
  }
  const audience = new URL(target.endpoint).origin;
  let last: SendResult = { ok: false, status: 0, gone: false, error: "not sent" };
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try {
      const jwt = await vapidJwt(keys, audience);
      const headers: Record<string, string> = {
        Authorization: `vapid t=${jwt}, k=${keys.public_key}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(CATEGORY_TTL_S[opts.category]),
        Urgency: CATEGORY_URGENCY[opts.category],
      };
      if (opts.topic !== undefined) headers["Topic"] = opts.topic;
      const res = await doFetch(target.endpoint, { method: "POST", headers, body: body as BufferSource });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const gone = res.status === 404 || res.status === 410;
      last = { ok: false, status: res.status, gone, error: `push service answered ${res.status}` };
      if (gone || (res.status < 500 && res.status !== 429)) return last;
    } catch (err) {
      last = { ok: false, status: 0, gone: false, error: err instanceof Error ? err.message : String(err) };
    }
    const wait = backoff[attempt];
    if (wait !== undefined) await sleep(wait);
  }
  return last;
}

/** Push topics are at most 32 URL-safe characters. */
export const topicFor = (tag: string): string => b64u(new Uint8Array(Buffer.from(tag))).replace(/[^A-Za-z0-9_-]/g, "").slice(-32);
