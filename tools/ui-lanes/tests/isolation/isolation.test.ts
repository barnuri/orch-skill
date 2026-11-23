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
    // Literal paths to the live home. A bare ".harness-orch" name is allowed: the runtime proof's sentinel uses it.
    expect(text, f).not.toMatch(/~\/\.harness-orch|\$\{?HOME\}?\/\.harness-orch|\/Users\/[^/\s"']+\/\.harness-orch|homedir\(\)[^\n]*harness-orch/);
    expect(text, f).not.toMatch(/localhost:6724|127\.0\.0\.1:6724/);
  }
});

test("compose stack bind-mounts the seeded lane home and uses no live port", () => {
  const yml = readFileSync(join(root, "integration/docker-compose.yml"), "utf8");
  expect(yml).toContain("${ORCH_LANE_HOME:?set by run.ts}:/orch-home");
  expect(yml).not.toMatch(/^volumes:/m);
  expect(yml).toContain("${ORCH_LANE_PORT:?set by run.ts}:6724");
  expect(yml).not.toMatch(/^\s*-\s*["']?(~|\/Users|\$HOME)/m);
});
