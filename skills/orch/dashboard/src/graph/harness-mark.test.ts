import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_MARK_IDS, harnessMarkMeta } from "./harness-mark";

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

describe("glyph definitions", () => {
  test("every advertised id resolves to a real mark, not the fallback ring", () => {
    const unresolved = HARNESS_MARK_IDS.filter((id) => !harnessMarkMeta(id).known);
    expect(unresolved).toEqual([]);
  });

  test("an unknown id does fall back", () => {
    expect(harnessMarkMeta("not-a-harness").known).toBe(false);
  });

  // These four ship the vendor's own mark; the rest are authored geometry.
  test("the official marks are the ones with a published logo", () => {
    const official = HARNESS_MARK_IDS.filter((id) => harnessMarkMeta(id).official);
    expect(official).toEqual(["claude", "cursor-agent", "codex", "gemini"]);
  });
});

describe("brand colours", () => {
  const css = readFileSync(join(SKILL_ROOT, "dashboard/styles.css"), "utf8");

  // A mark shipped without its brand colour silently renders in the muted default, which is
  // the whole point of using the vendor's logo lost.
  test("every official mark has a colour rule", () => {
    const missing = HARNESS_MARK_IDS.filter(
      (id) => harnessMarkMeta(id).official && !css.includes(`.mark-${id} {`),
    );
    expect(missing).toEqual([]);
  });

  // Cursor's mark is black and OpenAI's near-black: unreadable on the dark surface, so both
  // must invert for the light theme instead of being left at the dark-theme value.
  test("the marks that invert per theme have a light-theme override", () => {
    for (const id of ["cursor-agent", "codex", "claude"]) {
      expect(css).toContain(`[data-theme="light"] .mark-${id} {`);
    }
  });
});
