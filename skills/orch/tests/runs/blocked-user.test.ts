import { test, expect } from "bun:test";
import { orch, seedHome, runState, autoCleanup } from "../helpers";
autoCleanup();

// blocked-user: a node that waits for a user decision. Only the user's answer moves it.
test("blocked-user: entry needs a question, leaving clears it, dependents wait", () => {
  const home = seedHome(), o = orch(home);
  const st = () => runState(home, "bu-1");
  expect(o("run", "start", "Blocked user", "--id", "bu-1").rc).toBe(0);
  o("node", "add", "bu-1", "a", "Decide the API");
  o("node", "add", "bu-1", "b", "Build it", "--after", "a");

  // Entry without a question is refused: a blocked-user node always says what it waits for.
  let r = o("node", "update", "bu-1", "a", "blocked-user");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/blocked-user needs --needs-user/);
  expect(st().nodes[0].status).toBe("waiting");

  // waiting -> blocked-user with a question.
  r = o("node", "update", "bu-1", "a", "blocked-user", "--needs-user", "Use REST or GraphQL?");
  expect(r.rc).toBe(0);
  expect(st().nodes[0].status).toBe("blocked-user");
  expect(st().nodes[0].needs_user).toBe("Use REST or GraphQL?");

  // A blocked-user node moves only to waiting or skipped; never straight to running or done.
  r = o("node", "update", "bu-1", "a", "running");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/can move to: waiting skipped/);
  expect(o("node", "update", "bu-1", "a", "done").rc).toBe(2);

  // The dependent stays waiting, and the blocked node is never ready.
  expect(o("run", "sync", "bu-1").all).toMatch(/^ready: $/m);

  // The answer: back to waiting clears the question.
  expect(o("node", "update", "bu-1", "a", "waiting").rc).toBe(0);
  expect(st().nodes[0].status).toBe("waiting");
  expect(st().nodes[0].needs_user ?? null).toBeNull();
  expect(o("run", "sync", "bu-1").all).toMatch(/^ready: a$/m);

  // Leaving blocked-user for skipped also clears the question.
  o("node", "update", "bu-1", "a", "blocked-user", "--needs-user", "Drop the feature?");
  expect(o("node", "update", "bu-1", "a", "skipped", "--force", "--reason", "user dropped it").rc).toBe(0);
  expect(st().nodes[0].needs_user ?? null).toBeNull();
  o("run", "finish", "bu-1", "--force", "--reason", "test");
});

test("blocked-user: enters from running and error, not from done", () => {
  const home = seedHome(), o = orch(home);
  const st = () => runState(home, "bu-2");
  o("run", "start", "Blocked from running", "--id", "bu-2");
  o("node", "add", "bu-2", "a", "Work");
  o("node", "add", "bu-2", "b", "Other");
  o("node", "update", "bu-2", "a", "running");
  expect(o("node", "update", "bu-2", "a", "blocked-user", "--needs-user", "Ship to prod?").rc).toBe(0);
  expect(st().nodes[0].status).toBe("blocked-user");
  expect(st().nodes[0].seg_open).not.toBe(true);

  o("node", "update", "bu-2", "b", "error", "--error", "boom");
  expect(o("node", "update", "bu-2", "b", "blocked-user", "--needs-user", "Retry with the new key?").rc).toBe(0);
  expect(st().nodes[1].status).toBe("blocked-user");

  expect(o("node", "update", "bu-2", "b", "done").rc).toBe(2);
  o("node", "update", "bu-2", "b", "waiting");
  o("node", "update", "bu-2", "b", "running");
  o("node", "update", "bu-2", "b", "done");
  expect(st().nodes[1].status).toBe("done");
  const r = o("node", "update", "bu-2", "b", "blocked-user", "--needs-user", "again?");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/b is done; it can move to: nothing/);
  o("run", "finish", "bu-2", "--force", "--reason", "test");
});

test("blocked-user: a run with an open blocked-user node does not finish", () => {
  const home = seedHome(), o = orch(home);
  o("run", "start", "Gate", "--id", "bu-3");
  o("node", "add", "bu-3", "a", "Ask first");
  o("node", "update", "bu-3", "a", "blocked-user", "--needs-user", "Which region?");
  const r = o("run", "finish", "bu-3");
  expect(r.rc).not.toBe(0);
  expect(runState(home, "bu-3").status).toBe("running");
  o("run", "finish", "bu-3", "--force", "--reason", "test");
});
