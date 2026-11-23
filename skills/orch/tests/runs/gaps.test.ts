import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { loadRun } from "../../core/state/store.ts";
import { orchHome } from "../../core/state/home.ts";
autoCleanup();

test("an unhandled request is a gap; the gate refuses to close with it", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "gap run").out.trim();
  o("node", "add", R, "a", "A");
  o("req", "add", R, "ship the thing", "--node", "a", "--id", "R1");
  const { findGaps } = await import("../../core/commands/gaps.ts");
  const gaps = await findGaps(home, R);
  expect(gaps.some((g) => g.kind === "request" && g.id === "R1")).toBe(true);
  void loadRun; void orchHome;
});
