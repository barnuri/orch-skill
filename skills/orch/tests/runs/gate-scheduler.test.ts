import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, runState, autoCleanup } from "../helpers";
autoCleanup();

const setup = () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "0" });
  const R = o("run", "start", "gate run").out.trim();
  return { home, o, R };
};
const finishNode = (o: ReturnType<typeof orch>, R: string, id: string, handoff: string) => {
  o("node", "update", R, id, "running", "--owner", "coordinator");
  if (handoff) writeFileSync(join(o("node", "out", R, id).out.trim(), "handoff.md"), handoff);
  o("node", "result", R, id, "--verdict", "full", "--summary", "finished", "--follow-up", "none");
  o("node", "update", R, id, "done");
};

test("advance runs the done-gate itself when every other node is done, with no profile", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  o("req", "add", R, "do a", "--node", "a", "--id", "R1");
  o("req", "status", R, "R1", "done", "--force", "--reason", "closed by the test");
  finishNode(o, R, "a", "did it\n");
  const r = o("run", "advance", R);
  expect(r.out).toMatch(/gate run by scheduler: done-gate/);
  expect(r.out).not.toMatch(/needs-prompt/);
  expect(nodeOf(home, R, "done-gate").status).toBe("done");
  const handoff = readFileSync(join(o("node", "out", R, "done-gate").out.trim(), "handoff.md"), "utf8");
  expect(handoff).toMatch(/verify ok/);
  expect(r.rc).toBe(0);
  expect(runState(home, R).status).toBe("done");
});

test("advance marks the done-gate error with the verify failures when a handoff is missing", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  o("req", "add", R, "do a", "--node", "a", "--id", "R1");
  o("req", "status", R, "R1", "done", "--force", "--reason", "closed by the test");
  finishNode(o, R, "a", "");
  const r = o("run", "advance", R);
  expect(r.rc).toBe(1);
  expect(nodeOf(home, R, "done-gate").status).toBe("error");
  const handoff = readFileSync(join(o("node", "out", R, "done-gate").out.trim(), "handoff.md"), "utf8");
  expect(handoff).toMatch(/verify FAILED: 1 failure/);
  expect(handoff).toMatch(/node a is unverified: handoff.md is missing/);
  expect(runState(home, R).status).toBe("running");
});
