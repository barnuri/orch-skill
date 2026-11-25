import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { orch, seedHome, runState, autoCleanup } from "../helpers";
autoCleanup();

const setup = () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
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

test("run start adds no gate node and keeps none after new nodes", () => {
  const { home, R } = setup();
  expect(runState(home, R).nodes.map((n: any) => n.id)).toEqual(["a"]);
});

test("run gate passes: verify runs without a gate node and the run finishes", () => {
  const { home, o, R } = setup();
  finishNode(o, R, "a", "did it\n");
  const r = o("run", "gate", R);
  expect(r.rc).toBe(0);
  expect(runState(home, R).status).toBe("done");
  expect(runState(home, R).nodes.map((n: any) => n.id)).toEqual(["a"]);
});

test("run gate fails: run blocked with failures in needs_user, notice and review, orchestrator told, retry passes after the fix", () => {
  const { home, o, R } = setup();
  finishNode(o, R, "a", "");
  const r = o("run", "gate", R);
  expect(r.rc).toBe(1);
  const st: any = runState(home, R);
  expect(st.status).toBe("running");
  expect(st.needs_user).toMatch(/verify FAILED: 1 failure.*1\. \[a\]/s);
  expect(st.notice).toBe(st.needs_user);
  expect(st.review.state).toBe("failed");
  expect(st.review.failures[0].nodes).toEqual(["a"]);
  const dir = join(home, "runs", R, "inbox", "orch");
  expect(readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("")).toMatch(/run is blocked/);
  writeFileSync(join(o("node", "out", R, "a").out.trim(), "handoff.md"), "now present\n");
  o("node", "update", R, "a", "done");
  const r2 = o("run", "gate", R);
  expect(r2.err).toBe("");
  expect(r2.rc).toBe(0);
  expect(runState(home, R).status).toBe("done");
});

test("run gate does nothing while a node is open", () => {
  const { o, R } = setup();
  expect(o("run", "gate", R).out).toMatch(/not ready, open nodes: a/);
});

test("an old run with a waiting done-gate reads it as skipped and finishes", () => {
  const { home, o, R } = setup();
  finishNode(o, R, "a", "did it\n");
  const f = join(home, "runs", R, "state.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  st.nodes.push({ id: "done-gate", label: "Final gate: run verify", status: "waiting", after_all: true, role: "validation", attempts: [], usage: {}, log_tail: [] });
  writeFileSync(f, JSON.stringify(st));
  const v = o("run", "verify", R);
  expect(v.rc).toBe(0);
  expect(o("run", "finish", R).rc).toBe(0);
  const done: any = runState(home, R);
  expect(done.status).toBe("done");
  expect(done.nodes.find((n: any) => n.id === "done-gate").skip_reason).toMatch(/replaced by the orchestrator/);
});
