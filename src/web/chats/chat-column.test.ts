import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string): string => readFileSync(join(import.meta.dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const column = read("chat-column.css");

describe("one chat column", () => {
  test("every row takes the same width token and centres with auto inline margins", () => {
    for (const row of [".thread-scroll > *", ".composer > *", ".composer-row", ".chat-settings", ".composer-problems", ".composer-atts"]) {
      expect(column).toContain(row);
    }
    expect(column).toMatch(/max-width: var\(--measure\); margin-inline: auto; box-sizing: border-box/);
    for (const row of [".queue-tray", ".todo-panel", ".art-bar"]) {
      expect(column).toContain(row);
    }
    expect(column).toMatch(/width: min\(var\(--measure\), calc\(100% - 2 \* var\(--col-edge\)\)\)/);
  });

  test("the measure is a wide reading column, not the old 760px", () => {
    const tokens = readFileSync(join(import.meta.dir, "../../snapshot/tokens.css"), "utf8");
    const px = Number(/--measure:\s*(\d+)px/.exec(tokens)?.[1]);
    expect(px).toBeGreaterThanOrEqual(860);
    expect(px).toBeLessThanOrEqual(960);
  });

  test("no row positions itself with a physical or private offset", () => {
    expect(column).not.toMatch(/margin-left|margin-right|padding-left|padding-right|\bleft:|\bright:/);
    const working = read("working-indicator.css");
    expect(column).toContain(".thread-scroll > .working");
    expect(working).toContain(".working {");
  });

  test("the thread keeps a gutter on both edges and the composer adds the scrollbar width", () => {
    expect(column).toContain("scrollbar-gutter: stable both-edges");
    expect(column).toMatch(/--col-edge: calc\(var\(--col-pad\) \+ var\(--sbw, 0px\)\)/);
    expect(column).toMatch(/\.composer \{ padding-inline: var\(--col-edge\)/);
  });
});
