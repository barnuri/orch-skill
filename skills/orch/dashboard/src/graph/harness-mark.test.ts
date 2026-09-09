import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_MARK_IDS } from "./harness-mark";

const SKILL_ROOT: string = join(import.meta.dir, "..", "..", "..");

function shellList(source: string, name: string): string[] {
  const match = new RegExp(`^${name}="([^"]*)"`, "m").exec(source);
  return (match?.[1] ?? "").split(/\s+/).filter((entry) => entry !== "");
}

describe("harness glyph coverage", () => {
  // The two lists live in different files: the wired adapters in config.sh, the
  // detected-only CLIs in harness.sh.
  const configSh = readFileSync(join(SKILL_ROOT, "scripts/lib/config.sh"), "utf8");
  const harnessSh = readFileSync(join(SKILL_ROOT, "scripts/lib/harness.sh"), "utf8");
  const adapters = shellList(configSh, "VALID_HARNESSES");
  const detected = shellList(harnessSh, "DETECTED_CLI_IDS");

  // A zero-length scan would make the assertions below pass vacuously.
  test("the shell lists were actually parsed", () => {
    expect(adapters.length).toBeGreaterThan(2);
    expect(detected.length).toBeGreaterThan(2);
  });

  // Adding a harness to the CLI without a glyph silently falls back to the generic ring; this
  // is the reminder to draw one.
  test("every harness the CLI can report has its own glyph", () => {
    const missing = [...adapters, ...detected].filter(
      (id) => !(HARNESS_MARK_IDS as readonly string[]).includes(id),
    );
    expect(missing).toEqual([]);
  });

  test("no glyph is defined for an id the CLI does not know", () => {
    const known = new Set([...adapters, ...detected]);
    expect(HARNESS_MARK_IDS.filter((id) => !known.has(id))).toEqual([]);
  });

  test("ids are unique", () => {
    expect(new Set(HARNESS_MARK_IDS).size).toBe(HARNESS_MARK_IDS.length);
  });
});
