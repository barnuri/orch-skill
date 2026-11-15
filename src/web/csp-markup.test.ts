import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Both shells ship `style-src 'self'` with no 'unsafe-inline'. Any inline <style> or style=""
// attribute in the markup they load is refused, and WebKit logs a CSP error on every page load.
// That includes the SVG favicon: WebKit applies the page's policy to the icon's <style> element.
const SRC = join(import.meta.dir, "..");
const SHELLS: readonly string[] = ["web/index.html", "snapshot/index.html"];
const ICONS: readonly string[] = ["snapshot/favicon.svg", "snapshot/favicon-dark.svg"];
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

describe("CSP and markup", () => {
  for (const rel of SHELLS) {
    test(`${rel} keeps style-src 'self' and carries no inline style`, () => {
      const html = read(rel);
      const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(html).not.toMatch(/<style[\s>]/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
    });

    test(`${rel} picks the favicon by color scheme with media, not an inline style`, () => {
      const html = read(rel);
      expect(html).toMatch(/favicon\.svg" media="\(prefers-color-scheme: light\)"/);
      expect(html).toMatch(/favicon-dark\.svg" media="\(prefers-color-scheme: dark\)"/);
    });
  }

  for (const rel of ICONS) {
    test(`${rel} has no <style> element or style attribute`, () => {
      const svg = read(rel);
      expect(svg).not.toMatch(/<style[\s>]/i);
      expect(svg).not.toMatch(/\sstyle\s*=/i);
    });
  }

  // script-src 'self' forbids eval: zod's `new Function("")` JIT probe must be off before any parse.
  test("main.tsx turns zod's eval probe off first", () => {
    expect(read("web/main.tsx").split("\n")[0]).toBe('import "./zod-config";');
    expect(read("web/zod-config.ts")).toContain("z.config({ jitless: true })");
  });
});
