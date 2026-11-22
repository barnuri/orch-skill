import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, utimesSync } from "node:fs";
import { orch, orchSpawn, seedHome, nodeOf, runState, autoCleanup } from "../helpers";
autoCleanup();

const setup = () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "0" });
  const R = o("run", "start", "req run").out.trim();
  return { home, o, R };
};
const finishNode = (home: string, o: ReturnType<typeof orch>, R: string, id: string, handoff = "did it\n") => {
  o("node", "update", R, id, "running", "--owner", "coordinator");
  if (handoff) writeFileSync(join(o("node", "out", R, id).out.trim(), "handoff.md"), handoff);
  o("node", "result", R, id, "--verdict", "full", "--summary", "finished", "--follow-up", "none");
  o("node", "update", R, id, "done");
};

test("run start adds the last done-gate node and keeps it waiting after new nodes", () => {
  const { home, o, R } = setup();
  const g = nodeOf(home, R, "done-gate");
  expect([g.role, g.after_all, g.status]).toEqual(["validation", true, "waiting"]);
  expect(g.prompt).toContain(`run verify ${R}`);
  o("node", "add", R, "a", "A");
  expect(nodeOf(home, R, "done-gate").status).toBe("waiting");
});

test("ledger: add, link, evidence, status, list, check", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "n1", "N1");
  expect(o("req", "add", R, "make it fast", "--node", "n1").out.trim()).toBe("R1");
  expect(o("req", "add", R, "second", "--id", "X2").out.trim()).toBe("X2");
  expect(o("req", "link", R, "X2", "--node", "n1").rc).toBe(0);
  expect(o("req", "link", R, "X2", "--node", "ghost").rc).toBe(2);
  expect(o("req", "evidence", R, "R1", "--note", "bench", "--test", "bun test x", "--file", "a.ts").rc).toBe(0);
  expect(o("req", "status", R, "R1", "waived").rc).toBe(2);
  expect(o("req", "status", R, "R1", "bogus").rc).toBe(2);
  const l = JSON.parse(o("req", "list", R, "--json").out);
  expect(l.requirements[0].evidence[0]).toMatchObject({ note: "bench", test: "bun test x", file: "a.ts" });
  expect(l.requirements[1].nodes).toEqual(["n1"]);
  let c = o("req", "check", R);
  expect(c.rc).toBe(1);
  expect(c.out).toMatch(/R1 \[not\] OPEN/);
  expect(c.out).toMatch(/n1: waiting done=false handoff=no unverified=false/);
  finishNode(home, o, R, "n1");
  o("req", "status", R, "R1", "handled");
  o("req", "status", R, "X2", "waived", "--reason", "not needed");
  c = o("req", "check", R);
  expect(c.rc).toBe(0);
  expect(c.out).toMatch(/n1: done done=true handoff=yes unverified=false/);
  expect(runState(home, R).nodes.length).toBe(2);
});

test("run verify lists numbered failures and passes when clean; finish refuses unless forced", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  o("node", "add", R, "v", "V", "--role", "validation");
  o("req", "add", R, "do a", "--node", "a");
  finishNode(home, o, R, "a", "");
  o("node", "update", R, "v", "running", "--owner", "coordinator");
  o("node", "update", R, "v", "error", "--error", "bad");
  o("node", "update", R, "done-gate", "skipped", "--force", "--reason", "test skip");
  const v = o("run", "verify", R);
  expect(v.rc).toBe(1);
  expect(v.out).toMatch(/^\d+\. \[a\] node a is unverified: handoff.md is missing/m);
  expect(v.out).toMatch(/^1\. /m);
  expect(v.out).toMatch(/\[v\] node v is error/);
  expect(v.out).toMatch(/\[v\] validation node v did not pass/);
  expect(v.out).toMatch(/requirement R1 is not/);
  expect(v.out).toMatch(/fix: /);
  const f = o("run", "finish", R);
  expect(f.rc).toBe(1);
  expect(f.all).toMatch(/run finish refused/);
  expect(runState(home, R).status).toBe("running");
  expect(o("run", "finish", R, "--force").rc).toBe(2);
  expect(o("run", "finish", R, "--force", "--reason", "user accepted").rc).toBe(0);
  expect(runState(home, R).force_finish_reason).toBe("user accepted");
});

test("clean run verifies and finishes; open hold and open ask fail verify", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  finishNode(home, o, R, "a");
  o("req", "add", R, "do a", "--node", "a");
  o("req", "status", R, "R1", "handled");
  o("node", "update", R, "done-gate", "running", "--owner", "coordinator");
  writeFileSync(join(o("node", "out", R, "done-gate").out.trim(), "handoff.md"), "verified\n");
  o("node", "result", R, "done-gate", "--verdict", "full", "--summary", "verification passed", "--follow-up", "none");
  o("node", "update", R, "done-gate", "done");
  o("node", "update", R, "a", "--hold", "wait for user");
  const h = o("run", "verify", R);
  expect(h.rc).toBe(1);
  expect(h.out).toMatch(/node a is on hold/);
  o("node", "update", R, "a", "--clear-hold");
  const v = o("run", "verify", R);
  expect([v.rc, v.out.trim()]).toEqual([0, `verify ok: ${R}`]);
  expect(o("run", "finish", R).rc).toBe(0);
  expect(runState(home, R).status).toBe("done");
});

const verifyOut = (o: ReturnType<typeof orch>, R: string) => o("run", "verify", R).out;

test("whitespace handoff fails verify", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  finishNode(home, o, R, "a", " \n\t\n");
  expect(verifyOut(o, R)).toMatch(/node a is unverified: handoff.md is empty/);
});

test("stale handoff after a retry fails with the latest-attempt hint", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  finishNode(home, o, R, "a");
  const f = join(o("node", "out", R, "a").out.trim(), "handoff.md");
  expect(verifyOut(o, R)).not.toMatch(/node a /);
  o("node", "update", R, "a", "waiting", "--force");
  o("node", "update", R, "a", "running", "--owner", "coordinator");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(f, old, old);
  o("node", "update", R, "a", "done");
  expect(verifyOut(o, R)).toMatch(/handoff is older than the latest attempt/);
});

test("concurrent req add gives distinct ids", async () => {
  const { home, o, R } = setup();
  const sp = orchSpawn(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "0" });
  const rs = await Promise.all([1, 2, 3, 4].map((i) => sp("req", "add", R, `ask ${i}`)));
  const ids = rs.map((r) => r.out.trim());
  expect(rs.every((r) => r.rc === 0)).toBe(true);
  expect(new Set(ids).size).toBe(4);
  expect(JSON.parse(o("req", "list", R, "--json").out).requirements.length).toBe(4);
});

test("a gate running when a node is added waits again instead of ending done", () => {
  const { home, o, R } = setup();
  o("node", "update", R, "done-gate", "running", "--owner", "coordinator");
  o("node", "add", R, "late", "Late");
  o("node", "update", R, "done-gate", "done");
  expect(nodeOf(home, R, "done-gate").status).toBe("waiting");
});

test("forced skip needs a reason; unrecorded skip and skipped gate fail verify, recorded skip passes", () => {
  const { home, o, R } = setup();
  o("node", "add", R, "a", "A");
  expect(o("node", "update", R, "a", "skipped", "--force").rc).not.toBe(0);
  expect(o("node", "update", R, "a", "skipped", "--force", "--reason", "--force").rc).not.toBe(0);
  expect(o("node", "update", R, "a", "skipped", "--force", "--reason", "not needed").rc).toBe(0);
  expect(nodeOf(home, R, "a").skip_reason).toBe("not needed");
  expect(o("node", "update", R, "done-gate", "skipped", "--force", "--reason", "x").rc).toBe(0);
  expect(verifyOut(o, R)).toMatch(/done-gate was skipped/);
  expect(verifyOut(o, R)).not.toMatch(/node a was skipped/);
  const st = runState(home, R);
  delete (st.nodes.find((n: any) => n.id === "a") as any).skip_reason;
  writeFileSync(join(home, "runs", R, "state.json"), JSON.stringify(st));
  expect(verifyOut(o, R)).toMatch(/node a was skipped with no recorded reason/);
});

test("--reason does not consume a following flag", () => {
  const { o, R } = setup();
  o("node", "add", R, "n1", "N1");
  o("req", "add", R, "x", "--node", "n1");
  expect(o("req", "status", R, "R1", "waived", "--reason", "--json").rc).toBe(2);
  expect(o("run", "finish", R, "--force", "--reason", "--status").rc).toBe(2);
});
