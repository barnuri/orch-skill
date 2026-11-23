import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { loadRun } from "../../core/state/store.ts";
autoCleanup();

test("node add --plan --task stores the plan task on the node", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "plan run").out.trim();
  expect(o("node", "add", R, "t9", "T9 watchdog", "--plan", "/tmp/plan.md", "--task", "T9").rc).toBe(0);
  const n = (await loadRun(home, R))!.nodes.find((x: any) => x.id === "t9") as any;
  expect(n.plan).toEqual({ file: "/tmp/plan.md", task: "T9" });
});
