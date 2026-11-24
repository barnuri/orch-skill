import { test, expect } from "bun:test";
import { autoCleanup, orch, seedHome, runState } from "../helpers";

// CLI cases of the closure gate (G3). They spawn dispatch.ts, so they live outside the fast tier;
// the pure closure, ledger and audit cases stay in tests/unit/closure-gate.test.ts.
autoCleanup();

test("run finish refuses to close a run with an open node, even with --force", () => {
  const home = seedHome();
  const o = orch(home);
  o("run", "start", "Open", "--id", "open-1");
  o("node", "add", "open-1", "a", "work a");
  const r = o("run", "finish", "open-1", "--force", "--reason", "t");
  expect(r.rc).toBe(1);
  expect(runState(home, "open-1").status).toBe("running");
}, 120_000);

test("run carry skips moved nodes with a reason and leaves the run open when work remains", () => {
  const home = seedHome();
  const o = orch(home);
  o("run", "start", "Old", "--id", "old-2");
  o("run", "start", "New", "--id", "new-2");
  o("node", "add", "old-2", "a", "work a");
  const c = o("run", "carry", "old-2", "--id", "new-2b");
  expect(c.rc).toBe(0);
  const old = runState(home, "old-2");
  const a = old.nodes.find((n: any) => n.id === "a");
  expect(a.status).toBe("skipped");
  expect(a.skip_reason).toMatch(/moved to run/);
  expect(old.status).toBe("done");
}, 120_000);
