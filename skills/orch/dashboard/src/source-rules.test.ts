import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Guard rails the linter cannot express. The dashboard builds every node with
// createElement/textContent, so a single innerHTML would turn a run label — or a validation
// message echoed from a JSON file — into markup. Native dialogs are banned separately: they
// block the 2 s poll loop and cannot be themed, so the app ships its own confirm.
const SKILL_ROOT: string = join(import.meta.dir, "..", "..");
const BANNED = [
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "alert(",
  "confirm(",
  "prompt(",
  "eval(",
  "new Function",
  // The shell's CSP has no 'unsafe-inline', so an inline style string is refused and whatever
  // it was carrying silently does nothing. Custom properties go through the CSSOM instead.
  'setAttribute("style"',
] as const;

const glob = new Bun.Glob("**/*.ts");

function sourcesUnder(dir: string): string[] {
  return [...glob.scanSync({ cwd: join(SKILL_ROOT, dir), absolute: true })]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort();
}

function hits(paths: readonly string[], needle: string): string[] {
  const found: string[] = [];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (line.includes(needle)) {
        found.push(`${relative(SKILL_ROOT, path)}:${index + 1}`);
      }
    }
  }
  return found;
}

describe("dashboard source rules", () => {
  const sources = sourcesUnder("dashboard/src");

  // A zero-file scan would make every assertion below pass silently.
  test("the scan actually found the dashboard sources", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  for (const needle of BANNED) {
    test(`no ${needle} anywhere in dashboard/src`, () => {
      expect(hits(sources, needle)).toEqual([]);
    });
  }
});

describe("shared type rules", () => {
  const sources = sourcesUnder("shared");

  test("the scan actually found the shared types", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  // shared/ is imported by both the Bun server and the browser bundle, so anything
  // runtime-specific there breaks one of the two. Types only.
  test("no Bun API reaches the browser through shared/", () => {
    expect(hits(sources, "Bun.")).toEqual([]);
  });
});
