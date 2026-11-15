import { describe, expect, test } from "bun:test";

import { profileAccent, profileAccentSoft, profilePalette } from "./profile-color";

// The user's own six profiles. `claude-llm-hub` and `cursor-llm-hub` both hashed to hue 188
// under the old name-hash scheme, so two different lanes drew in the same colour.
const REAL_PROFILES = [
  "claude-haiku",
  "claude-sub",
  "claude-opus",
  "cursor-default",
  "claude-llm-hub",
  "cursor-llm-hub",
] as const;

describe("profilePalette", () => {
  test("no two profiles in a run share a colour", () => {
    const palette = profilePalette(REAL_PROFILES);
    const colours = REAL_PROFILES.map((name) => palette.accent(name));
    expect(new Set(colours).size).toBe(REAL_PROFILES.length);
  });

  test("the specific pair that used to collide no longer does", () => {
    const palette = profilePalette(REAL_PROFILES);
    expect(palette.accent("claude-llm-hub")).not.toBe(palette.accent("cursor-llm-hub"));
  });

  test("a colour is stable across calls for the same run", () => {
    const a = profilePalette(REAL_PROFILES);
    const b = profilePalette(REAL_PROFILES);
    for (const name of REAL_PROFILES) {
      expect(a.accent(name)).toBe(b.accent(name));
    }
  });

  // Assignment is by index over the sorted set, so the order nodes happen to appear in must
  // not change any node's colour.
  test("input order does not affect assignment", () => {
    const forward = profilePalette(REAL_PROFILES);
    const reversed = profilePalette([...REAL_PROFILES].reverse());
    for (const name of REAL_PROFILES) {
      expect(forward.accent(name)).toBe(reversed.accent(name));
    }
  });

  test("duplicates in the input are collapsed", () => {
    const palette = profilePalette(["a", "a", "b"]);
    expect(palette.accent("a")).not.toBe(palette.accent("b"));
  });

  test("soft and accent differ for the same profile", () => {
    const palette = profilePalette(REAL_PROFILES);
    expect(palette.soft("claude-sub")).not.toBe(palette.accent("claude-sub"));
  });

  test("twelve profiles still all differ", () => {
    const many = Array.from({ length: 12 }, (_, i) => `profile-${i}`);
    const palette = profilePalette(many);
    expect(new Set(many.map((n) => palette.accent(n))).size).toBe(12);
  });

  // Past the palette the wheel repeats — documented, not a bug worth more hues than a reader
  // can distinguish.
  test("beyond the palette hues repeat rather than throwing", () => {
    const many = Array.from({ length: 14 }, (_, i) => `p${i}`);
    const palette = profilePalette(many);
    const colours = many.map((n) => palette.accent(n));
    expect(new Set(colours).size).toBe(12);
  });

  test("an unknown name still resolves to a colour", () => {
    const palette = profilePalette(["a"]);
    expect(palette.accent("never-seen")).toMatch(/^hsl\(/);
  });
});

describe("context-free helpers", () => {
  test("both return an hsl colour and are stable", () => {
    expect(profileAccent("claude-sub")).toMatch(/^hsl\(/);
    expect(profileAccent("claude-sub")).toBe(profileAccent("claude-sub"));
    expect(profileAccentSoft("claude-sub")).toMatch(/^hsl\(/);
  });
});
