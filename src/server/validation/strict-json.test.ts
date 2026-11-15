import { describe, expect, test } from "bun:test";

import { MAX_NESTING_DEPTH, findDuplicateKey, parseJsonStrict } from "./strict-json.ts";

const DEEP = 100_000;

describe("parseJsonStrict", () => {
  test("nested duplicate key names the repeated key", () => {
    const result = parseJsonStrict('{"settings":{"a":1,"a":2},"profiles":{}}');
    expect(result).toEqual({ ok: false, error: "duplicate key a" });
  });

  test("duplicate key at the root", () => {
    const result = parseJsonStrict('{"settings":{},"settings":{}}');
    expect(result).toEqual({ ok: false, error: "duplicate key settings" });
  });

  test("NaN is a syntax error", () => {
    const result = parseJsonStrict("NaN");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("NaN");
    }
  });

  test("trailing comma is a syntax error", () => {
    const result = parseJsonStrict("[1,2,]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("non-JSON text is a syntax error", () => {
    const result = parseJsonStrict("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("100k-deep nesting is rejected as nesting too deep", () => {
    const result = parseJsonStrict("[".repeat(DEEP) + "]".repeat(DEEP));
    expect(result).toEqual({ ok: false, error: "nesting too deep" });
  });

  test("nesting up to the cap is accepted", () => {
    const result = parseJsonStrict("[".repeat(MAX_NESTING_DEPTH) + "]".repeat(MAX_NESTING_DEPTH));
    expect(result.ok).toBe(true);
  });

  test("valid documents parse to their value", () => {
    expect(parseJsonStrict("[]")).toEqual({ ok: true, value: [] });
    expect(parseJsonStrict('{"settings":{},"profiles":{}}')).toEqual({
      ok: true,
      value: { settings: {}, profiles: {} },
    });
    expect(parseJsonStrict('"r\\u00e9sum\\u00e9 \\"quoted\\""')).toEqual({
      ok: true,
      value: 'résumé "quoted"',
    });
  });

  test("same key in sibling objects is not a duplicate", () => {
    const result = parseJsonStrict('{"profiles":{"a":{"harness":"claude"},"b":{"harness":"claude"}}}');
    expect(result.ok).toBe(true);
  });
});

describe("findDuplicateKey", () => {
  test("ignores braces and quotes inside strings", () => {
    expect(findDuplicateKey('{"a":"{\\"a\\":1,\\"a\\":2}","b":"[{,"}')).toBeNull();
    expect(findDuplicateKey('{"a":["a","a"],"b":"a"}')).toBeNull();
  });

  test("returns null for text without objects", () => {
    expect(findDuplicateKey("[1,2,3]")).toBeNull();
    expect(findDuplicateKey("not json")).toBeNull();
  });

  test("finds the duplicate after a nested value", () => {
    expect(findDuplicateKey('{"a":{"b":1},"c":[1,2],"a":2}')).toBe("a");
  });

  test("throws RangeError past the nesting cap", () => {
    const depth = MAX_NESTING_DEPTH + 1;
    expect(() => findDuplicateKey("[".repeat(depth) + "]".repeat(depth))).toThrow(RangeError);
  });
});
