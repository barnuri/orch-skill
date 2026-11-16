import { test, expect, setDefaultTimeout } from "bun:test";
import { orch, seedHome, nodeOf, events, autoCleanup } from "../helpers";
import { isEngineNode } from "../../../../src/shared/engine-node";
setDefaultTimeout(60000);
autoCleanup();

test("a node added with --origin loop is an engine node: done without handoff is not marked unverified", () => {
  const home = seedHome();
  const o = orch(home);
  o("run", "start", "Loop run", "--id", "loop-20261116-100000-ab12");
  expect(o("node", "add", "loop-20261116-100000-ab12", "i1", "Tick 1", "--origin", "loop").rc).toBe(0);
  o("run", "start", "Normal", "--id", "r1");
  o("node", "add", "r1", "a", "A");
  expect(nodeOf(home, "loop-20261116-100000-ab12", "i1").origin).toBe("loop");
  expect(nodeOf(home, "r1", "a").origin).toBeUndefined();

  o("node", "update", "loop-20261116-100000-ab12", "i1", "running");
  const tick = o("node", "update", "loop-20261116-100000-ab12", "i1", "done");
  expect(tick.rc).toBe(0);
  expect(tick.err).not.toMatch(/done without handoff/);
  expect(nodeOf(home, "loop-20261116-100000-ab12", "i1").unverified ?? null).toBeNull();
  expect(events(home, "loop-20261116-100000-ab12").some((e) => e.kind === "note")).toBe(false);

  o("node", "update", "r1", "a", "running");
  const normal = o("node", "update", "r1", "a", "done");
  expect(normal.err).toMatch(/done without handoff: a/);
  expect(nodeOf(home, "r1", "a").unverified).toBe(true);
});

test("--origin only takes loop or watch", () => {
  const home = seedHome();
  const o = orch(home);
  o("run", "start", "Normal", "--id", "r1");
  const bad = o("node", "add", "r1", "a", "A", "--origin", "coordinator");
  expect(bad.rc).toBe(2);
  expect(bad.err).toMatch(/--origin must be one of: loop watch/);
});

test("isEngineNode: marker, loop_id, or a tick id in a loop or watch run", () => {
  expect(isEngineNode("r1", { id: "a" })).toBe(false);
  expect(isEngineNode("r1", { id: "i3" })).toBe(false);
  expect(isEngineNode("r1", { id: "a", origin: "loop" })).toBe(true);
  expect(isEngineNode("r1", { id: "a", loop_id: "loop-x" })).toBe(true);
  expect(isEngineNode("loop-20261116-100000-ab12", { id: "i3" })).toBe(true);
  expect(isEngineNode("watch-20261116-100000-ab12", { id: "i3" })).toBe(true);
  expect(isEngineNode("loop-20261116-100000-ab12", { id: "work" })).toBe(false);
});
