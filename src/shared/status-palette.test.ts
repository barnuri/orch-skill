import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATUS_KEYS, STATUS_PALETTE, paletteClass, statusKeyOf } from "./status-palette";
import type { StatusKey } from "./status-palette";

const SNAPSHOT = join(import.meta.dir, "../snapshot");
const tokens = readFileSync(join(SNAPSHOT, "tokens.css"), "utf8");
const components = readFileSync(join(SNAPSHOT, "components.css"), "utf8");

/** The mapping the issue asks for: one tone per status, nothing else. */
const EXPECTED: Record<StatusKey, { label: string; tone: string }> = {
  covered: { label: "Covered", tone: "purple" },
  skipped: { label: "Skipped", tone: "gray" },
  partial: { label: "Partial", tone: "amber" },
  full: { label: "Full", tone: "green" },
  done: { label: "Done", tone: "green" },
  blocked: { label: "Blocked", tone: "red" },
  error: { label: "Error", tone: "red" },
  waiting: { label: "Waiting", tone: "blue-gray" },
  "blocked-user": { label: "Blocked by user", tone: "amber" },
};

describe("shared status palette", () => {
  test("holds exactly the nine statuses of the spec", () => {
    expect([...STATUS_KEYS].sort()).toEqual(Object.keys(EXPECTED).sort() as StatusKey[]);
  });

  for (const [key, want] of Object.entries(EXPECTED) as [StatusKey, { label: string; tone: string }][]) {
    test(`${key} is ${want.tone} with the visible label "${want.label}"`, () => {
      expect<{ label: string; tone: string }>(STATUS_PALETTE[key]).toEqual(want);
      expect(statusKeyOf(key)).toBe(key);
      expect(paletteClass(key)).toBe(`status-${key}`);
    });

    test(`${key} has its own token set in tokens.css (colour, background, border)`, () => {
      expect(tokens).toMatch(new RegExp(`--status-${key}: light-dark\\(|--status-${key}: var\\(`));
      expect(tokens).toMatch(new RegExp(`--status-${key}-bg:`));
      expect(tokens).toMatch(new RegExp(`--status-${key}-bd:`));
    });

    test(`${key} chip and class rules read the ${key} tokens`, () => {
      const rule = components.split("\n").find((line) => line.includes(`.status-${key}`) && line.includes("--bg-c"));
      expect(rule).toBeDefined();
      expect(rule).toContain(`--c: var(--status-${key});`);
      expect(rule).toContain(`--bg-c: var(--status-${key}-bg);`);
      expect(rule).toContain(`--bd-c: var(--status-${key}-bd);`);
    });
  }

  test("words outside the palette get no status class", () => {
    for (const word of ["running", "stale", "unknown", "unowned", ""]) {
      expect(statusKeyOf(word)).toBeNull();
      expect(paletteClass(word)).toBe("");
    }
  });

  test("the result verdicts full, partial and blocked are palette keys; unknown is not", () => {
    expect(paletteClass("full")).toBe("status-full");
    expect(paletteClass("partial")).toBe("status-partial");
    expect(paletteClass("blocked")).toBe("status-blocked");
    expect(paletteClass("unknown")).toBe("");
  });

  test("only blocked and error are red; green, amber, purple, gray and blue-gray are not", () => {
    const red = Object.entries(STATUS_PALETTE).filter(([, v]) => v.tone === "red").map(([k]) => k);
    expect(red.sort()).toEqual(["blocked", "error"]);
  });
});
