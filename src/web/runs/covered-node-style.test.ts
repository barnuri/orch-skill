import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A covered node is purple in the graph: status bar and frame, also with a profile and when selected.
test("covered graph nodes use the covered token for the bar and the frame", () => {
  const css = readFileSync(join(import.meta.dir, "../../snapshot/styles.css"), "utf8");
  expect(css).toMatch(/\.node\.covered \.mark \{ fill: var\(--status-covered\)/);
  expect(css).toMatch(/\.node\.has-profile\.covered \.frame[^{]*\{ stroke: var\(--status-covered\)/);
  expect(css).toMatch(/\.run-page \.node\.has-profile\.covered\.selected \.frame \{ stroke: var\(--status-covered\)/);
});
