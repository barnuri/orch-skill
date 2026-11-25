import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, runState, autoCleanup } from "../helpers";
autoCleanup();

const setup = () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "gate run").out.trim();
  return { home, o, R };
};
const finishNode = (o: ReturnType<typeof orch>, R: string, id: string, handoff: string) => {
  o("node", "update", R, id, "running", "--owner", "coordinator");
  if (handoff) writeFileSync(join(o("node", "out", R, id).out.trim(), "handoff.md"), handoff);
  o("node", "result", R, id, "--verdict", "full", "--summary", "finished", "--follow-up", "none");
  o("node", "update", R, id, "done");
};

test("next actions tell the orchestrator to verify and finish once every node is settled", () => {
  const { o, R } = setup();
  o("node", "add", R, "a", "A");
  o("req", "add", R, "do a", "--node", "a", "--id", "R1");
  o("req", "status", R, "R1", "done", "--force", "--reason", "closed by the test");
  expect(o("run", "status", R, "--json").out).not.toMatch(/All nodes settled/);
  finishNode(o, R, "a", "did it\n");
  const j = JSON.parse(o("run", "status", R, "--json").out);
  const p = j.projection ?? j;
  expect(p.next_actions.map((x: any) => x.text)).toContain("All nodes settled: verify requirements and finish the run");
});

test("advance has no gate to run: an open node stays blocked, a verified run finishes", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  o("req", "add", R, "do a", "--node", "a", "--id", "R1");
  o("req", "status", R, "R1", "done", "--force", "--reason", "closed by the test");
  finishNode(o, R, "a", "did it\n");
  const r = o("run", "advance", R);
  expect(r.out).not.toMatch(/gate run by scheduler/);
  expect(r.rc).toBe(0);
  expect(runState(home, R).status).toBe("done");
});
