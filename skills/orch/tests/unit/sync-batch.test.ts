import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
autoCleanup();

test("run sync-batch syncs several runs in one process and reports the failing one", () => {
  const home = seedHome();
  const o = orch(home, {});
  const a = o("run", "start", "batch a").out.trim();
  const b = o("run", "start", "batch b").out.trim();
  expect(o("run", "sync-batch", a, b, "--no-retry", "--lock").rc).toBe(0);
  const bad = o("run", "sync-batch", a, "no-such-run", b);
  expect(bad.rc).not.toBe(0);
  expect(bad.out).toContain("no-such-run rc=");
  expect(o("run", "sync-batch").rc).toBe(2);
});
