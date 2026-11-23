import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".vite-cache" || n === "tests") return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("lanes never reference the live orch home or live port", () => {
  for (const f of files(root).filter((p) => /\.(ts|yml|json)$/.test(p) && !p.endsWith("package-lock.json"))) {
    const text = readFileSync(f, "utf8").replace(/refusing to use the live service port 6724/g, "");
    expect(text, f).not.toMatch(/\.harness-orch/);
    expect(text, f).not.toMatch(/localhost:6724|127\.0\.0\.1:6724/);
  }
});

test("compose stack uses a named volume and a non-live host port", () => {
  const yml = readFileSync(join(root, "integration/docker-compose.yml"), "utf8");
  expect(yml).toContain("lane-home:/orch-home");
  expect(yml).toContain("16724");
  expect(yml).not.toMatch(/^\s*-\s*["']?(~|\/Users|\$HOME)/m);
});
