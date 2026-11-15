import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient } from "./client";
import { StatusStore } from "./status";
import { conditionalGet, dropEtags } from "./queries";
import type { ApiResult } from "./result";

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
const store = new Map<string, string>();

function respond(make: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(make(url, init));
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  store.clear();
  (globalThis as Record<string, unknown>)["sessionStorage"] = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  dropEtags();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>)["sessionStorage"];
});

const header = (call: { init: RequestInit } | undefined, name: string): string | null => new Headers(call?.init.headers).get(name);

describe("ApiClient", () => {
  test("sends the bearer token and If-None-Match, maps 304", async () => {
    store.set("orch-token", "tok");
    respond(() => new Response(null, { status: 304 }));
    const status = new StatusStore();
    const result = await new ApiClient(status).getSchedules('"v1"');
    expect(result.kind).toBe("unchanged");
    expect(header(calls[0], "Authorization")).toBe("Bearer tok");
    expect(header(calls[0], "If-None-Match")).toBe('"v1"');
    expect(status.get().lastOkAt).not.toBeNull();
  });

  test("a quiet GET marks the connection live on success but never reports failure", async () => {
    const status = new StatusStore();
    const client = new ApiClient(status);
    respond(() => json({ jobs: [] }));
    await client.request("GET", "/api/x", z.unknown(), { quiet: true });
    expect(status.get().lastOkAt).not.toBeNull();
    respond(() => json({ error: "nope" }, 500));
    await client.request("GET", "/api/x", z.unknown(), { quiet: true });
    expect(status.get().lastError).toBeNull();
  });

  test("parses a document envelope and folds the enum list", async () => {
    respond(() => json({ document: { profiles: {}, settings: {} }, issues: [], limits: { max_body_bytes: 9 }, harnesses: ["claude"] }, 200, { ETag: '"e"' }));
    const result = await new ApiClient(new StatusStore()).getDocument("profiles", null);
    expect(result.kind === "ok" && result.body.enums).toEqual(["claude"]);
    expect(result.kind === "ok" && result.etag).toBe('"e"');
  });

  test("a body that breaks the DTO schema is invalid, not trusted", async () => {
    respond(() => json({ generated_at: 5, schedules: "nope" }));
    const status = new StatusStore();
    const result = await new ApiClient(status).getSchedules(null);
    expect(result.kind).toBe("invalid");
    expect(status.get().lastError).not.toBeNull();
  });

  test("PUT sends If-Match and JSON; 401 raises the gate; errors keep the {error} shape", async () => {
    respond(() => json({ error: "stale", etag: '"n"' }, 412));
    const status = new StatusStore();
    const result = await new ApiClient(status).putDocument("memory", [], '"old"');
    expect(header(calls[0], "If-Match")).toBe('"old"');
    expect(header(calls[0], "Content-Type")).toBe("application/json");
    expect(result).toEqual({ kind: "error", status: 412, body: { error: "stale", etag: '"n"' } });
    respond(() => json({ error: "token" }, 401));
    await new ApiClient(status).getSchedules(null);
    expect(status.get().authRequired).toBe(true);
  });

  test("network failure resolves, never throws", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("down"))) as unknown as typeof fetch;
    const status = new StatusStore();
    expect((await new ApiClient(status).getSchedules(null)).kind).toBe("network");
    expect(status.get().lastError).toContain("offline");
  });
});

describe("conditionalGet", () => {
  test("a 304 returns the same cached object", async () => {
    let n = 0;
    const fetcher = (etag: string | null): Promise<ApiResult<{ n: number }>> =>
      Promise.resolve(etag === null ? { kind: "ok", body: { n: ++n }, etag: '"1"' } : { kind: "unchanged" });
    const a = await conditionalGet("k", fetcher);
    const b = await conditionalGet("k", fetcher);
    expect(b).toBe(a);
    dropEtags();
    expect((await conditionalGet("k", fetcher)).n).toBe(2);
  });
});
