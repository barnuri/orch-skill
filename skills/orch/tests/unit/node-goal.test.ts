import { test, expect } from "bun:test";
import { appendNodeGoal } from "../../core/commands/dispatch.ts";
import { seedHome, orch, nodeOf, autoCleanup } from "../helpers";
autoCleanup();

test("appendNodeGoal adds a Your task section only for a see-node-goal prompt", () => {
  expect(appendNodeGoal("see node goal", "Build the parser")).toBe("see node goal\n\n## Your task\nBuild the parser\n");
  expect(appendNodeGoal("  See the node goal.  ", "Build")).toBe("See the node goal.\n\n## Your task\nBuild\n");
  expect(appendNodeGoal("Implement X. See node goal for detail.", "Build")).toBe("Implement X. See node goal for detail.");
  expect(appendNodeGoal("see node goal", "")).toBe("see node goal");
  expect(appendNodeGoal("@/tmp/p.md", "Build")).toBe("@/tmp/p.md");
});

test("node brief names ORCH_NODE_GOAL and ORCH_NODE_GOAL_FILE", () => {
  const home = seedHome(), o = orch(home);
  const R = o("run", "start", "brief demo").out.trim();
  const add = o.in('{"op":"add","id":"a","goal":"Alpha"}\n', "node", "batch", R);
  expect(add.rc).toBe(0);
  expect(nodeOf(home, R, "a").status).toBeDefined();
  const r = o("node", "brief", R, "a");
  expect(r.rc).toBe(0);
  expect(r.out).toContain("$ORCH_NODE_GOAL_FILE");
  expect(r.out).toContain("$ORCH_NODE_GOAL");
});
