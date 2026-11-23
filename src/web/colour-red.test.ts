import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Red means error or failure only (CLAUDE.md, UI colour). Every CSS rule that paints with a red
 * token or a red hex must name an error state in its selector. Tokens are defined in
 * src/snapshot/tokens.css, which this test skips: it is the definition, not a use.
 */
const SCAN_ROOTS = [import.meta.dir, join(import.meta.dir, "../snapshot")];
const TOKEN_FILE = join(import.meta.dir, "../snapshot/tokens.css");

/** A selector may paint red only when it names an error, failure or invalid state. `.notice` is the error alert (`.notice.warn` and `.notice.info` are not red). */
const ALLOWED_SELECTOR = /error|fail|invalid|problem|dead|down|offline|\berr\b|\bnotice\b|\bis-bad\b|needs-attention|\bis-er\b|dialog|\.confirm\b|blocked/;

const RED_TOKEN = /--(status-error|er|erbg|erbd)(?![\w-])/;

/** A hex colour with a high red channel and low green and blue: `#aa1f1f`, `#ff3b30`. */
function isRedHex(hex: string): boolean {
  const n = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return r >= 0xa0 && g < 0x60 && b < 0x60;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".css") && !f.includes("node_modules"))
    .map((f) => join(dir, f))
    .filter((f) => f !== TOKEN_FILE);
}

/** Rules as [file, selector, body]. Comments are removed; @media wrappers are walked through. */
function rules(file: string): Array<[string, string, string]> {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<[string, string, string]> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? "").trim();
    if (selector.startsWith("@")) {
      continue;
    }
    out.push([file, selector, m[2] ?? ""]);
  }
  return out;
}

function redViolations(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of cssFiles(root)) {
      for (const [, selector, body] of rules(file)) {
        const red = RED_TOKEN.test(body) || [...body.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].some((m) => isRedHex(m[1] ?? ""));
        const redKeyword = /(^|[\s:])red\b/.test(body);
        if ((red || redKeyword) && !ALLOWED_SELECTOR.test(selector)) {
          found.push(`${relative(join(import.meta.dir, "../.."), file)}: ${selector}`);
        }
      }
    }
  }
  return found;
}

describe("red is for error and failure only", () => {
  test("no component css paints red outside an error selector", () => {
    expect(redViolations()).toEqual([]);
  });

  test("the scan catches a red rule on a neutral selector", () => {
    expect(isRedHex("aa1f1f")).toBe(true);
    expect(isRedHex("1f7a4d")).toBe(false);
    expect(RED_TOKEN.test("color: var(--status-error)")).toBe(true);
    expect(RED_TOKEN.test("color: var(--status-stale)")).toBe(false);
  });
});
