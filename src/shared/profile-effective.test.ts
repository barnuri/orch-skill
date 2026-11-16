import { describe, expect, test } from "bun:test";
import { effectiveProfile } from "./profile-effective";

describe("effectiveProfile resolution order", () => {
  test("node override beats profile, defaults and builtin", () => {
    const e = effectiveProfile({ max_parallel: 2 }, { max_parallel: 7 }, { max_parallel: 1 });
    expect(e.max_parallel).toEqual({ value: 1, source: "node" });
  });

  test("profile beats defaults", () => {
    const e = effectiveProfile({ parallel_ok: false }, { parallel_ok: true });
    expect(e.parallel_ok).toEqual({ value: false, source: "profile" });
  });

  test("defaults beat builtin", () => {
    const e = effectiveProfile({}, { max_parallel: 7 });
    expect(e.max_parallel).toEqual({ value: 7, source: "defaults" });
  });

  test("builtin fills keys nobody sets", () => {
    const e = effectiveProfile({}, {});
    expect(e.parallel_ok).toEqual({ value: true, source: "builtin" });
    expect(e.max_parallel).toEqual({ value: 7, source: "builtin" });
    expect(e.timeout_min).toEqual({ value: null, source: "builtin" });
  });

  test("env merges key by key, profile wins per key, node wins over both", () => {
    const e = effectiveProfile(
      { env: { A: "profile", B: "profile" } },
      { env: { A: "defaults", C: "defaults" } },
      { env: { B: "node" } },
    );
    expect(e.env.value).toEqual({ A: "profile", B: "node", C: "defaults" });
    expect(e.env.source).toBe("node");
  });

  test("env source is defaults when only defaults sets it", () => {
    const e = effectiveProfile({}, { env: { C: "x" } });
    expect(e.env).toEqual({ value: { C: "x" }, source: "defaults" });
  });

  test("flags are replaced, not merged", () => {
    const e = effectiveProfile({ flags: ["--a"] }, { flags: ["--b"] });
    expect(e.flags).toEqual({ value: ["--a"], source: "profile" });
  });
});
