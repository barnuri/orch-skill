import { describe, expect, test } from "bun:test";

import { readJsonBody } from "./body";

const MAX: number = 64;

function post(init: RequestInit = {}): Request {
  return new Request("http://localhost/api/x", { method: "POST", ...init });
}

async function statusOf(result: Awaited<ReturnType<typeof readJsonBody>>): Promise<number> {
  return result.ok ? 200 : result.response.status;
}

describe("readJsonBody", () => {
  test("a JSON body is returned verbatim", async () => {
    const result = await readJsonBody(
      post({ headers: { "Content-Type": "application/json" }, body: '{"a":1}' }),
      MAX,
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.text : "").toBe('{"a":1}');
  });

  test("a charset parameter is still application/json", async () => {
    const result = await readJsonBody(
      post({ headers: { "Content-Type": "application/json; charset=utf-8" }, body: "{}" }),
      MAX,
    );
    expect(await statusOf(result)).toBe(200);
  });

  test("a wrong media type is 415", async () => {
    const result = await readJsonBody(post({ headers: { "Content-Type": "text/plain" }, body: "x" }), MAX);
    expect(await statusOf(result)).toBe(415);
  });

  test("an oversized body is 413", async () => {
    const result = await readJsonBody(
      post({ headers: { "Content-Type": "application/json" }, body: `"${"x".repeat(MAX * 2)}"` }),
      MAX,
    );
    expect(await statusOf(result)).toBe(413);
  });

  // A no-argument POST ("sanity test all", "apply all") has no body, so it has no media type to
  // declare — demanding one made the whole feature unreachable from the dashboard.
  describe("allowEmpty", () => {
    test("a body-less POST is 415 by default", async () => {
      expect(await statusOf(await readJsonBody(post(), MAX))).toBe(415);
    });

    test("a body-less POST is accepted as empty text when allowed", async () => {
      const result = await readJsonBody(post(), MAX, true);
      expect(result.ok).toBe(true);
      expect(result.ok ? result.text : "unset").toBe("");
    });

    test("an explicit zero Content-Length still counts as body-less", async () => {
      const result = await readJsonBody(post({ headers: { "Content-Length": "0" } }), MAX, true);
      expect(await statusOf(result)).toBe(200);
    });

    // allowEmpty must not become a way to smuggle a non-JSON body past the media-type check.
    test("a body with the wrong media type is still 415", async () => {
      const result = await readJsonBody(
        post({ headers: { "Content-Type": "text/plain" }, body: "x" }),
        MAX,
        true,
      );
      expect(await statusOf(result)).toBe(415);
    });

    test("a JSON body is still read when empty is allowed", async () => {
      const result = await readJsonBody(
        post({ headers: { "Content-Type": "application/json" }, body: '{"profile":"x"}' }),
        MAX,
        true,
      );
      expect(result.ok ? result.text : "").toBe('{"profile":"x"}');
    });
  });
});
