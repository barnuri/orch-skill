import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
autoCleanup();

test("suggest learn records a fix for a node that ended early without a handoff", () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "learn run").out.trim();
  o("node", "add", R, "a", "A");
  o("node", "update", R, "a", "running", "--owner", "coordinator");
  o("node", "update", R, "a", "error", "--force", "--error", "ended early without handoff");
  const r = o("suggest", "learn", "--json");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/"signature": "ended-early-no-handoff"/);
  const sug = JSON.parse(readFileSync(join(home, "suggestions.json"), "utf8")).suggestions;
  expect(sug.some((s: any) => s.kind === "orch-fix" && s.signature === "ended-early-no-handoff" && s.fix.length > 0)).toBe(true);
});
