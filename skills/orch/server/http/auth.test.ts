import { describe, expect, test } from "bun:test";

import { bearerToken, digestToken, isAuthorized } from "./auth";

const TOKEN: string = "kQ3v9zJ8mN2pL5rT7wX1yB4cD6fG0hA9sE2uI5oP8lK";
const TOKEN_DIGEST: Uint8Array = digestToken(TOKEN);
const SHA256_BYTES: number = 32;

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:6724/api/health", { headers });
}

describe("bearerToken", () => {
  test("extracts the token from a Bearer header", () => {
    expect(bearerToken(requestWith({ Authorization: `Bearer ${TOKEN}` }))).toBe(TOKEN);
  });

  test("ignores other schemes and the query string", () => {
    expect(bearerToken(requestWith({ Authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
    expect(bearerToken(new Request(`http://127.0.0.1:6724/api/health?token=${TOKEN}`))).toBeNull();
  });

  test("returns null when the header is missing or empty", () => {
    expect(bearerToken(requestWith({}))).toBeNull();
    expect(bearerToken(requestWith({ Authorization: "Bearer " }))).toBeNull();
  });
});

describe("digestToken", () => {
  test("is a 32-byte SHA-256 digest, stable for the same input", () => {
    expect(TOKEN_DIGEST.byteLength).toBe(SHA256_BYTES);
    expect(Buffer.from(digestToken(TOKEN)).equals(Buffer.from(TOKEN_DIGEST))).toBe(true);
    expect(Buffer.from(digestToken("other")).equals(Buffer.from(TOKEN_DIGEST))).toBe(false);
  });
});

describe("isAuthorized", () => {
  test("accepts the matching token", () => {
    expect(isAuthorized(requestWith({ Authorization: `Bearer ${TOKEN}` }), TOKEN_DIGEST)).toBe(true);
  });

  test("rejects a wrong token of the same length", () => {
    const wrong = `${TOKEN.slice(0, -1)}Z`;
    expect(isAuthorized(requestWith({ Authorization: `Bearer ${wrong}` }), TOKEN_DIGEST)).toBe(false);
  });

  test("rejects Basic auth and a missing header", () => {
    expect(isAuthorized(requestWith({ Authorization: `Basic ${TOKEN}` }), TOKEN_DIGEST)).toBe(false);
    expect(isAuthorized(requestWith({}), TOKEN_DIGEST)).toBe(false);
  });

  test("never throws on a wrong-length candidate", () => {
    expect(isAuthorized(requestWith({ Authorization: "Bearer x" }), TOKEN_DIGEST)).toBe(false);
    expect(isAuthorized(requestWith({ Authorization: `Bearer ${TOKEN}${TOKEN}` }), TOKEN_DIGEST)).toBe(
      false,
    );
  });

  test("never throws when the stored digest has an unexpected length", () => {
    expect(isAuthorized(requestWith({ Authorization: `Bearer ${TOKEN}` }), new Uint8Array(0))).toBe(
      false,
    );
  });
});
