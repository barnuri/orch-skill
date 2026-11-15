import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// One tokens file owns every theme value. Anything else that names a raw colour or a theme
// selector forks the theme, so a token edit would no longer restyle the whole app.
const DASHBOARD: string = join(import.meta.dir, "..");
const read = (name: string): string => readFileSync(join(DASHBOARD, name), "utf8");
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("theme source", () => {
  for (const file of ["styles.css", "components.css"]) {
    const css = withoutComments(read(file));

    test(`${file} has no raw colour`, () => {
      expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)).toBeNull();
    });
    test(`${file} has no theme selector or colour-scheme query`, () => {
      expect(css).not.toContain("[data-theme");
      expect(css).not.toContain("prefers-color-scheme");
    });
  }

  test("every theme-dependent colour in tokens.css is declared once with light-dark()", () => {
    const tokens = withoutComments(read("tokens.css"));
    expect(tokens).toContain("--bg: light-dark(");
    expect(tokens).not.toContain("prefers-color-scheme");
  });
});
