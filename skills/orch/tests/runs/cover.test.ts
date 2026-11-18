import { test, expect } from "bun:test";
import { orch, seedHome, runState, autoCleanup } from "../helpers";
autoCleanup();

function setup() {
  const home = seedHome();
  const o = orch(home);
  o("run", "start", "Old", "--id", "old-1");
  o("run", "start", "New", "--id", "new-1");
  o("node", "add", "old-1", "a", "work a");
  o("node", "add", "old-1", "b", "work b");
  o("node", "add", "new-1", "a2", "work a again");
  o("node", "update", "old-1", "a", "done");
  return { home, o, st: (id: string) => runState(home, id) };
}

test("run cover sets status, fields and carried nodes; uncover undoes", () => {
  const { o, st } = setup();
  const r = o("run", "cover", "old-1", "--by", "new-1", "--note", "carried", "--map", "b=a2");
  expect(r.rc).toBe(0);
  const s = st("old-1");
  expect(s.status).toBe("covered");
  expect(s.covered_by).toBe("new-1");
  expect(s.covered_note).toBe("carried");
  expect(s.covered_at).toBeTruthy();
  expect(s.covered_map).toEqual({ b: "a2" });
  expect(s.covered_nodes).toContain("b");
  expect(s.covered_nodes).not.toContain("a");
  expect(o("run", "list").out).toMatch(/old-1\tcovered/);
  expect(o("run", "status", "old-1").out).toMatch(/covered by new-1/);
  // run finish keeps covered
  o("run", "finish", "old-1", "--force", "--reason", "t");
  expect(st("old-1").status).toBe("covered");
  const u = o("run", "uncover", "old-1");
  expect(u.rc).toBe(0);
  expect(st("old-1").status).toBe("running");
  expect(st("old-1").covered_by).toBeUndefined();
});

test("run cover refuses unknown, same run, bad map, uncovered uncover", () => {
  const { o, st } = setup();
  expect(o("run", "cover", "old-1", "--by", "nope-9").rc).not.toBe(0);
  expect(o("run", "cover", "old-1", "--by", "old-1").rc).toBe(2);
  expect(o("run", "cover", "old-1").rc).toBe(2);
  expect(o("run", "cover", "old-1", "--by", "new-1", "--map", "zz=a2").rc).toBe(2);
  expect(st("old-1").status).toBe("running");
  expect(o("run", "uncover", "old-1").rc).toBe(2);
});

test("a done run can be covered and uncovers back to done", () => {
  const { o, st } = setup();
  o("node", "update", "old-1", "b", "done");
  o("run", "finish", "old-1", "--force", "--reason", "t");
  expect(st("old-1").status).toBe("done");
  expect(o("run", "cover", "old-1", "--by", "new-1").rc).toBe(0);
  expect(o("run", "uncover", "old-1").rc).toBe(0);
  expect(st("old-1").status).toBe("done");
});
