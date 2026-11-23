import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { loadRun, saveRun } from "../../core/state/store.ts";
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

test("a done node whose owner stopped is a gap until a coordinator result is recorded", async () => {
  const { findGaps } = await import("../../core/commands/gaps.ts");
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "owner stopped").out.trim();
  o("node", "add", R, "n1", "n1");
  o("node", "update", R, "n1", "done", "--force");
  const run = (await loadRun(home, R))!;
  const n = run.nodes.find((x: any) => x.id === "n1") as any;
  n.owner_state = "finished";
  n.result = { verdict: "partial", summary: "self report", follow_up: "", at: "x" };
  await saveRun(home, R, run);
  const gaps = await findGaps(home, R);
  expect(gaps.some((g) => g.kind === "no-result" && g.id === "n1" && /owner stopped/.test(g.detail))).toBe(true);
  o("node", "result", R, "n1", "--verdict", "full", "--summary", "reviewed");
  const after = await findGaps(home, R);
  expect(after.some((g) => g.kind === "no-result" && g.id === "n1")).toBe(false);
});
