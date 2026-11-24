import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { autoCleanup, orch, seedHome, readJson } from "../helpers";

autoCleanup();

function setup() {
  const home = seedHome();
  const o = orch(home);
  const run = o("run", "start", "Lifecycle", "--id", "life-1").out.trim();
  o("node", "add", run, "impl", "Implement", "--profile", "claude-default");
  o("node", "add", run, "other", "Other implementer", "--profile", "local-llm-fast");
  o("node", "add", run, "v1", "Verifier", "--profile", "local-llm-fast");
  o("node", "update", run, "impl", "running", "--force");
  mkdirSync(join(home, "runs", run, "out", "impl"), { recursive: true });
  writeFileSync(join(home, "runs", run, "out", "impl", "handoff.md"), "# done\n");
  o("node", "result", run, "impl", "--verdict", "full", "--summary", "built", "--follow-up", "none");
  o("node", "update", run, "impl", "done");
  o("req", "add", run, "Make it fast", "--id", "R1", "--node", "impl");
  const ledger = () => readJson(join(home, "runs", run, "requirements.json")).requirements[0];
  return { home, o, run, ledger };
}

test("a requirement moves open -> implemented -> verifying -> done, and the implementer cannot verify it", () => {
  const { o, run, ledger } = setup();
  expect(ledger().status).toBe("open");
  expect(o("req", "status", run, "R1", "implemented").rc).toBe(2); // no evidence yet
  o("req", "evidence", run, "R1", "--note", "bench 2x faster");
  expect(o("req", "status", run, "R1", "implemented").rc).toBe(0);
  expect(ledger().implemented_by).toEqual(["impl"]);
  expect(o("req", "status", run, "R1", "done").rc).toBe(2); // done needs a verifier
  const self = o("req", "status", run, "R1", "verifying", "--verifier", "impl");
  expect(self.rc).toBe(2);
  expect(self.all).toMatch(/implemented R1/);
  expect(o("req", "status", run, "R1", "verifying", "--verifier", "v1").rc).toBe(0);
  expect(ledger().verifier).toBe("v1");
  // A different node and profile: its verdict closes the requirement, and it is not a forced close.
  expect(o("req", "verdict", run, "R1", "pass", "--node", "impl").rc).toBe(2);
  expect(o("req", "verdict", run, "R1", "pass", "--node", "v1", "--note", "ran the bench").rc).toBe(0);
  expect(ledger().status).toBe("done");
  expect(ledger().forced ?? null).toBeNull();
});

test("a verifier with the implementer's profile is refused", () => {
  const { o, run } = setup();
  o("node", "add", run, "same", "Same profile", "--profile", "claude-default");
  o("req", "evidence", run, "R1", "--note", "x");
  o("req", "status", run, "R1", "implemented");
  const r = o("req", "status", run, "R1", "verifying", "--verifier", "same");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/profile claude-default/);
});

test("a failing verdict reopens the requirement and creates one gap node per gap", () => {
  const { o, run, ledger } = setup();
  o("req", "evidence", run, "R1", "--note", "x");
  o("req", "status", run, "R1", "implemented");
  o("req", "status", run, "R1", "verifying", "--verifier", "v1");
  const r = o("req", "verdict", run, "R1", "fail", "--node", "v1", "--gap", "no loader on the run page", "--gap", "covered is not purple");
  expect(r.rc).toBe(0);
  expect(ledger().status).toBe("in_progress");
  expect(ledger().nodes).toEqual(expect.arrayContaining(["impl", "gap-R1-1", "gap-R1-2"]));
});

test("a person can close it with --force and a reason, and it is recorded", () => {
  const { o, run, ledger } = setup();
  expect(o("req", "status", run, "R1", "done", "--force").rc).toBe(2);
  expect(o("req", "status", run, "R1", "done", "--force", "--reason", "checked by hand").rc).toBe(0);
  expect(ledger().forced).toBe("checked by hand");
});

test("legacy names still work: not, partly, handled", () => {
  const { o, run, ledger } = setup();
  expect(o("req", "status", run, "R1", "partly").rc).toBe(0);
  expect(ledger().status).toBe("in_progress");
  expect(o("req", "status", run, "R1", "not").rc).toBe(0);
  expect(ledger().status).toBe("open");
});
