import { describe, expect, test } from "bun:test";

import { parseRoute, routeKey } from "./router.ts";

describe("parseRoute", () => {
  test("empty hash is the list", () => {
    expect(parseRoute("")).toEqual({ kind: "list" });
  });

  test("#/ is the list", () => {
    expect(parseRoute("#/")).toEqual({ kind: "list" });
  });

  test("#/profiles, #/harnesses, #/memory and #/suggestions are exact matches", () => {
    expect(parseRoute("#/profiles")).toEqual({ kind: "profiles" });
    expect(parseRoute("#/harnesses")).toEqual({ kind: "harnesses" });
    expect(parseRoute("#/memory")).toEqual({ kind: "memory" });
    expect(parseRoute("#/suggestions")).toEqual({ kind: "suggestions" });
  });

  test("a trailing segment does not make it the profiles route", () => {
    expect(parseRoute("#/profiles/x")).toEqual({ kind: "list" });
  });

  test("a run hash carries the id", () => {
    expect(parseRoute("#/run/20260903-120000-abcd")).toEqual({
      kind: "run",
      runId: "20260903-120000-abcd",
    });
  });

  test("a percent-encoded id is decoded", () => {
    expect(parseRoute("#/run/a%20b")).toEqual({ kind: "run", runId: "a b" });
  });

  // The hash is user-controlled; a malformed escape must fall back, not throw.
  test("a malformed escape falls back to the list", () => {
    expect(parseRoute("#/run/%E0%A4%A")).toEqual({ kind: "list" });
  });

  test("an empty run id falls back to the list", () => {
    expect(parseRoute("#/run/")).toEqual({ kind: "list" });
  });

  // A single space is a real (if odd) id — only an empty one falls back.
  test("an id that decodes to whitespace is still a run", () => {
    expect(parseRoute("#/run/%20")).toEqual({ kind: "run", runId: " " });
  });

  test("an unknown hash is the list", () => {
    expect(parseRoute("#/nope")).toEqual({ kind: "list" });
  });
});

describe("routeKey", () => {
  test("static routes key on their kind", () => {
    expect(routeKey({ kind: "list" })).toBe("list");
    expect(routeKey({ kind: "profiles" })).toBe("profiles");
    expect(routeKey({ kind: "harnesses" })).toBe("harnesses");
    expect(routeKey({ kind: "memory" })).toBe("memory");
    expect(routeKey({ kind: "suggestions" })).toBe("suggestions");
  });

  test("run routes include the id so a poll for another run reads as stale", () => {
    expect(routeKey({ kind: "run", runId: "r1" })).toBe("run:r1");
    expect(routeKey({ kind: "run", runId: "r1" })).not.toBe(routeKey({ kind: "run", runId: "r2" }));
  });
});
