import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { seedHome, autoCleanup } from "../helpers";
import { applyOwnerState } from "../../core/commands/owners.ts";
import { newCtx } from "../../core/runs/node.ts";
autoCleanup();

// The run page's "needs review" banner reads `unverified`. A node whose agent already recorded its own result is
// reviewed: the owner stopping later must not flag it again (every run showed the banner before this).
test("owner finished: unverified only when no result was recorded", () => {
  const home = seedHome();
  const job = "job-1";
  mkdirSync(join(home, "jobs", job), { recursive: true });
  const mk = (extra: Record<string, unknown>): any => ({ run_id: "r", nodes: [{ id: "n", label: "n", status: "running", ...extra }], edges: [] });
  const reviewed = mk({ reviewed: true, result: { verdict: "full", summary: "s", follow_up: "none", at: "x" } });
  applyOwnerState(reviewed, newCtx(home, "r"), "n", "finished", "", job, "test", "2026-11-24T00:00:00Z");
  expect(reviewed.nodes[0].status).toBe("done");
  expect(reviewed.nodes[0].unverified).toBeNull();
  const silent = mk({});
  applyOwnerState(silent, newCtx(home, "r"), "n", "finished", "", job, "test", "2026-11-24T00:00:00Z");
  expect(silent.nodes[0].unverified).toBe(true);
});
