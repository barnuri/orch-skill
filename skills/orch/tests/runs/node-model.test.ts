import { test, expect } from "bun:test";
import { orch, seedHome, runState, autoCleanup } from "../helpers";
autoCleanup();

// claude-default is allowed only claude-sonnet, so a node that asks for claude-opus must fail before any job starts.
test("node dispatch refuses an explicit model outside the profile's allowed_models", () => {
  const home = seedHome(), o = orch(home);
  o("run", "start", "Model guard", "--id", "mg-1");
  o("node", "add", "mg-1", "a", "Pick model", "--profile", "claude-default", "--model", "claude-opus");
  const r = o("node", "dispatch", "mg-1", "a", "hello");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/node dispatch: a: model claude-opus is not in allowed_models of profile claude-default/);
  const n = runState(home, "mg-1").nodes.find((x: any) => x.id === "a");
  expect(n.status).toBe("waiting");
  expect(n.job_id ?? null).toBeNull();
});

test("node dispatch refuses a model the profile harness does not serve", () => {
  const home = seedHome(), o = orch(home);
  o("run", "start", "Harness guard", "--id", "hg-1");
  o("node", "add", "hg-1", "a", "Pick model", "--profile", "claude-default", "--model", "gpt-not-here");
  const r = o("node", "dispatch", "hg-1", "a", "hello");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/model gpt-not-here is not served by profile claude-default \(harness claude\)/);
});
