import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "chat-design.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("chat design layer", () => {
  test("uses tokens only: no raw colour", () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(css.match(/\b(rgba?|hsla?|oklch)\(/g) ?? []).toEqual([]);
  });

  test("the reading tokens exist and the layer is imported last", () => {
    const tokens = readFileSync(join(import.meta.dir, "../../snapshot/tokens.css"), "utf8");
    for (const name of ["--measure", "--fs-read", "--lh-read", "--r-card"]) {
      expect(tokens).toContain(`${name}:`);
    }
    const styles = readFileSync(join(import.meta.dir, "../styles.css"), "utf8");
    expect(styles.indexOf("chat-design.css")).toBeGreaterThan(styles.indexOf("chats.css"));
  });

  test("code stays left to right and message text picks its own direction", () => {
    expect(css).toMatch(/\.code-block \{[^}]*direction: ltr/);
    expect(css).toMatch(/\.user-text \{[^}]*unicode-bidi: plaintext/);
  });

  test("motion is switched off under reduced motion", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*transition: none/);
  });
});
