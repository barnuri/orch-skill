import { describe, expect, test } from "bun:test";

import { b64u, decryptPayload, encryptPayload, endpointAllowed, fromB64u, generateVapid, sendPush, topicFor, verifyVapidJwt, vapidJwt } from "./webpush";

const subtle = crypto.subtle;
// RFC 8291 section 5 and appendix A example.
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const HEADER = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
// The RFC prints header and ciphertext as separate base64url strings; the message is their byte concatenation.
const EXPECTED = b64u(Buffer.concat([fromB64u(HEADER), fromB64u(CIPHERTEXT)]));

async function ecdhPair(pub: string, priv: string): Promise<CryptoKeyPair> {
  const p = fromB64u(pub);
  const jwk = (d: string): JsonWebKey => ({ kty: "EC", crv: "P-256", x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), d, ext: true });
  return {
    publicKey: await subtle.importKey("raw", p as BufferSource, { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: await subtle.importKey("jwk", jwk(priv), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
  };
}

describe("RFC 8291 encryption", () => {
  test("matches the RFC example byte for byte", async () => {
    const plain = new TextEncoder().encode("When I grow up, I want to be a watermelon");
    const out = await encryptPayload(plain, UA_PUBLIC, AUTH, { salt: fromB64u(SALT), asKeyPair: await ecdhPair(AS_PUBLIC, AS_PRIVATE) });
    expect(b64u(out)).toBe(EXPECTED);
  });

  test("the user agent decrypts the RFC message", async () => {
    const ua = await ecdhPair(UA_PUBLIC, UA_PRIVATE);
    const plain = await decryptPayload(fromB64u(EXPECTED), ua.privateKey, UA_PUBLIC, AUTH);
    expect(new TextDecoder().decode(plain)).toBe("When I grow up, I want to be a watermelon");
  });

  test("round trip with fresh keys, including non-ASCII text", async () => {
    const ua = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const pub = b64u(new Uint8Array(await subtle.exportKey("raw", ua.publicKey)));
    const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const text = "שלום, התשובה מוכנה ✓";
    const body = await encryptPayload(new TextEncoder().encode(text), pub, auth);
    expect(new TextDecoder().decode(await decryptPayload(body, ua.privateKey, pub, auth))).toBe(text);
  });
});

describe("VAPID", () => {
  test("the JWT verifies with the public key and carries aud, exp and sub", async () => {
    const keys = await generateVapid("mailto:a@b.co");
    const jwt = await vapidJwt(keys, "https://push.example", 1_000);
    const claims = await verifyVapidJwt(jwt, keys.public_key);
    expect(claims).toEqual({ aud: "https://push.example", exp: 1_000 + 12 * 3600, sub: "mailto:a@b.co" });
    expect(JSON.parse(Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(fromB64u(keys.public_key).length).toBe(65);
  });

  test("a tampered or foreign-key JWT fails", async () => {
    const a = await generateVapid();
    const b = await generateVapid();
    const jwt = await vapidJwt(a, "https://x");
    expect(await verifyVapidJwt(jwt, b.public_key)).toBeNull();
    const [h, , s] = jwt.split(".");
    expect(await verifyVapidJwt(`${h}.${b64u(new TextEncoder().encode('{"aud":"https://evil"}'))}.${s}`, a.public_key)).toBeNull();
  });
});

describe("sendPush", () => {
  const target = async () => {
    const ua = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    return { endpoint: "https://push.example/abc", p256dh: b64u(new Uint8Array(await subtle.exportKey("raw", ua.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  };

  test("sends TTL, urgency, vapid auth and aes128gcm", async () => {
    const keys = await generateVapid();
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const r = await sendPush(keys, await target(), { a: 1 }, {
      category: "questions",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string> };
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(seen!.headers["Urgency"]).toBe("high");
    expect(seen!.headers["TTL"]).toBe(String(6 * 3600));
    expect(seen!.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(seen!.headers["Authorization"]).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  });

  test("410 and 404 are gone and are not retried", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      return new Response(null, { status: 410 });
    }) as unknown as typeof fetch;
    const r = await sendPush(await generateVapid(), await target(), {}, { category: "replies", fetchImpl: f, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, gone: true, status: 410 });
    expect(calls).toBe(1);
  });

  test("5xx retries with backoff, then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const f = (async () => new Response(null, { status: ++calls < 3 ? 503 : 201 })) as unknown as typeof fetch;
    const r = await sendPush(await generateVapid(), await target(), {}, { category: "replies", fetchImpl: f, sleep: async (ms) => void waits.push(ms) });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([1000, 4000]);
  });

  test("a non-push endpoint is refused without a request", async () => {
    expect(endpointAllowed("http://example.com/x")).toBe(false);
    expect(endpointAllowed("http://127.0.0.1:9/x")).toBe(true);
    expect(endpointAllowed("https://fcm.googleapis.com/x")).toBe(true);
    let called = false;
    const r = await sendPush(await generateVapid(), { endpoint: "http://example.com/x", p256dh: "", auth: "" }, {}, { category: "replies", fetchImpl: (async () => { called = true; return new Response(); }) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("topic is at most 32 url-safe characters", () => {
    expect(topicFor("chat:" + "x".repeat(80))).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});
