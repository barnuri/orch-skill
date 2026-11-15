import { describe, expect, test } from "bun:test";

import { applyToastFor } from "./suggestion-logic";

describe("applyToastFor reasons", () => {
  test("a single failure shows its reason", () => {
    const env = { ok: false, applied: 0, failed: 1, results: [{ id: "a", ok: false, error: "unknown profile claude-haiku" }] };
    expect(applyToastFor(env)).toEqual({ kind: "error", text: "unknown profile claude-haiku" });
  });
  test("no reason keeps the old text", () => {
    expect(applyToastFor({ ok: false, applied: 0, failed: 1, results: [] }).text).toBe("Apply failed");
  });
  test("many failures append the first reason", () => {
    const results = [{ id: "a", ok: false, error: "boom" }, { id: "b", ok: false }];
    expect(applyToastFor({ ok: false, applied: 0, failed: 2, results }).text).toBe("2 failed: boom");
  });
});
