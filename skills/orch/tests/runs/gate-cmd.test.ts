import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, runState, autoCleanup } from "../helpers";
autoCleanup();

const setup = () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "0" });
  const R = o("run", "start", "gate cmd").out.trim();
  o("node", "add", R, "a", "A");
  o("req", "add", R, "do a", "--node", "a", "--id", "R1");
  o("req", "status", R, "R1", "done", "--force", "--reason", "closed by the test");
  return { home, o, R };
};
const finishNode = (o: ReturnType<typeof orch>, R: string, id: string, handoff: string) => {
  o("node", "update", R, id, "running", "--owner", "coordinator");
  if (handoff) writeFileSync(join(o("node", "out", R, id).out.trim(), "handoff.md"), handoff);
  o("node", "result", R, id, "--verdict", "full", "--summary", "finished", "--follow-up", "none");
  o("node", "update", R, id, "done");
};

test("run gate passes: gate done with verify output as handoff and result, run finished", () => {
  const { home, o, R } = setup();
  finishNode(o, R, "a", "did it\n");
  const r = o("run", "gate", R);
  expect(r.rc).toBe(0);
  expect(nodeOf(home, R, "done-gate").status).toBe("done");
  expect(readFileSync(join(o("node", "out", R, "done-gate").out.trim(), "handoff.md"), "utf8")).toMatch(/verify ok/);
  expect(JSON.stringify(nodeOf(home, R, "done-gate"))).toMatch(/verification passed/);
  expect(runState(home, R).status).toBe("done");
});

test("run gate fails: gate blocked-user with failures, run open, orchestrator told, retry passes after the fix", () => {
  const { home, o, R } = setup();
  finishNode(o, R, "a", "");
  const r = o("run", "gate", R);
  expect(r.rc).toBe(1);
  const gate: any = nodeOf(home, R, "done-gate");
  expect(gate.status).toBe("blocked-user");
  expect(gate.needs_user).toMatch(/verify FAILED: 1 failure.*1\. \[a\]/s);
  expect(readFileSync(join(o("node", "out", R, "done-gate").out.trim(), "handoff.md"), "utf8")).toMatch(/verify FAILED: 1 failure/);
  expect(runState(home, R).status).toBe("running");
  const dir = join(home, "runs", R, "inbox", "orch");
  expect(readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("")).toMatch(/done-gate failed/);
  writeFileSync(join(o("node", "out", R, "a").out.trim(), "handoff.md"), "now present\n");
  o("node", "update", R, "a", "done");
  const r2 = o("run", "gate", R);
  expect(r2.err).toBe("");
  expect(r2.rc).toBe(0);
  expect(runState(home, R).status).toBe("done");
});

test("run gate does nothing while another node is open; node dispatch of the gate is still accepted", () => {
  const { home, o, R } = setup();
  const r = o("run", "gate", R);
  expect(r.out).toMatch(/not ready/);
  expect(nodeOf(home, R, "done-gate").status).toBe("waiting");
  const d = o("node", "dispatch", R, "done-gate", "--help");
  expect(d.err + d.out).not.toMatch(/unknown/i);
});
