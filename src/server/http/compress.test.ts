import { beforeEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { clearCompressCache, compressJsonResponse, pickEncoding } from "./compress";

const big = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, name: `row-${i}` })) });
const json = (body: string, extra: Record<string, string> = {}): Response => new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
const get = (ae?: string): Request => new Request("http://x/api/a", { headers: ae === undefined ? {} : { "Accept-Encoding": ae } });

beforeEach(clearCompressCache);

describe("pickEncoding", () => {
  test("prefers br, then gzip, honors q=0", () => {
    expect(pickEncoding("gzip, br")).toBe("br");
    expect(pickEncoding("gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("identity")).toBeNull();
    expect(pickEncoding(null)).toBeNull();
  });
});

describe("compressJsonResponse", () => {
  test("gzips a large JSON body and keeps the ETag", async () => {
    const res = await compressJsonResponse(get("gzip"), json(big, { ETag: '"e1"' }));
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("ETag")).toBe('"e1"');
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBeLessThan(big.length / 3);
    expect(gunzipSync(body).toString()).toBe(big);
  });
  test("leaves small bodies and clients without Accept-Encoding alone", async () => {
    expect((await compressJsonResponse(get("gzip"), json('{"a":1}'))).headers.get("Content-Encoding")).toBeNull();
    const plain = await compressJsonResponse(get(), json(big));
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(await plain.text()).toBe(big);
  });
  test("skips non-JSON, errors and already-encoded bodies", async () => {
    expect((await compressJsonResponse(get("gzip"), new Response(big, { headers: { "Content-Type": "text/event-stream" } }))).headers.get("Content-Encoding")).toBeNull();
    expect((await compressJsonResponse(get("gzip"), new Response(big, { status: 500, headers: { "Content-Type": "application/json" } }))).headers.get("Content-Encoding")).toBeNull();
  });
  test("same ETag reuses the compressed body", async () => {
    const a = new Uint8Array(await (await compressJsonResponse(get("gzip"), json(big, { ETag: '"e2"' }))).arrayBuffer());
    const b = new Uint8Array(await (await compressJsonResponse(get("gzip"), json(big, { ETag: '"e2"' }))).arrayBuffer());
    expect(Buffer.compare(a, b)).toBe(0);
  });
});
