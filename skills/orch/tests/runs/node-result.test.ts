import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, autoCleanup } from "../helpers";
autoCleanup();

function setup() {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_WAIT_POLL_SECS: "1" });
  const R = o("run", "start", "result check").out.trim();
  for (const n of ["a", "b", "c"]) o("node", "add", R, n, n.toUpperCase());
  const finish = (id: string) => {
    o("node", "update", R, id, "running", "--owner", "coordinator");
    writeFileSync(join(o("node", "out", R, id).out.trim(), "handoff.md"), "detail\n");
  };
  return { home, o, R, finish };
}

test("node result is stored on the node", () => {
  const { home, o, R } = setup();
  const r = o("node", "result", R, "a", "--verdict", "partial", "--summary", "did half", "--follow-up", "finish the parser");
  expect(r.rc).toBe(0);
  const res = nodeOf(home, R, "a").result;
  expect(res).toMatchObject({ verdict: "partial", summary: "did half", follow_up: "finish the parser" });
  expect(typeof res.at).toBe("string");
});

test("node result reads run and node from the env", () => {
  const { home, R } = setup();
  const e = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_RUN_ID: R, ORCH_NODE_ID: "b" });
  expect(e("node", "result", "--verdict", "full", "--summary", "all good").rc).toBe(0);
  expect(nodeOf(home, R, "b").result).toMatchObject({ verdict: "full", summary: "all good", follow_up: "none" });
});

test("blocked needs a summary and the verdict must be valid", () => {
  const { o, R } = setup();
  const r = o("node", "result", R, "a", "--verdict", "blocked", "--summary", "  ");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/blocked verdict needs a non-empty --summary/);
  expect(o("node", "result", R, "a", "--verdict", "maybe", "--summary", "x").rc).toBe(2);
});

test("done with no result records unknown and warns", () => {
  const { home, o, R, finish } = setup();
  finish("a");
  const r = o("node", "update", R, "a", "done");
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/^done without a result: a /m);
  expect(nodeOf(home, R, "a").result.verdict).toBe("unknown");
});

test("done with a result keeps it and does not warn", () => {
  const { home, o, R, finish } = setup();
  finish("a");
  o("node", "result", R, "a", "--verdict", "full", "--summary", "ok");
  expect(o("node", "update", R, "a", "done").all).not.toMatch(/without a result/);
  expect(nodeOf(home, R, "a").result.verdict).toBe("full");
});

test("run verify lists partial and blocked unless follow_up is none", () => {
  const { o, R, finish } = setup();
  for (const id of ["a", "b", "c"]) finish(id);
  o("node", "result", R, "a", "--verdict", "partial", "--summary", "half", "--follow-up", "port the rest");
  o("node", "result", R, "b", "--verdict", "blocked", "--summary", "no creds", "--follow-up", "none");
  o("node", "result", R, "c", "--verdict", "partial", "--summary", "half", "--follow-up", "none");
  for (const id of ["a", "b", "c"]) o("node", "update", R, id, "done");
  const v = o("run", "verify", R);
  expect(v.out).toMatch(/\[a\] node a needs follow-up: \[partial\] half \| follow_up: port the rest/);
  expect(v.out).not.toMatch(/\[b\] node b needs follow-up/);
  expect(v.out).not.toMatch(/\[c\] node c needs follow-up/);
});

test("run wait transition line carries the result, truncated to 200 chars", () => {
  const { o, R, finish } = setup();
  finish("a");
  o("run", "wait", R, "--timeout", "1");
  const long = "x".repeat(400);
  o("node", "result", R, "a", "--verdict", "partial", "--summary", "short", "--follow-up", "do z");
  o("node", "update", R, "a", "done");
  let w = o("run", "wait", R, "--timeout", "5");
  expect(w.out).toMatch(/^a running->done \[partial\] short \| follow_up: do z$/m);
  finish("b");
  o("run", "wait", R, "--timeout", "1");
  o("node", "result", R, "b", "--verdict", "partial", "--summary", long, "--follow-up", "y");
  o("node", "update", R, "b", "done");
  w = o("run", "wait", R, "--timeout", "5");
  const line = w.out.split("\n").find((l) => l.startsWith("b running->done"))!;
  expect(line).toMatch(/^b running->done \[partial\] x+…$/);
  expect(line.length).toBeLessThanOrEqual("b running->done [partial] ".length + 200);
  expect(o("node", "show", R, "b").out).toContain(long);
});

test("run status shows the result per node", () => {
  const { o, R, finish } = setup();
  finish("a");
  o("node", "result", R, "a", "--verdict", "full", "--summary", "shipped");
  o("node", "update", R, "a", "done");
  expect(o("run", "status", R).out).toMatch(/^result a: \[full\] shipped$/m);
  expect(JSON.parse(o("run", "status", R, "--json").out).results[0]).toMatchObject({ id: "a", verdict: "full" });
});

test("node brief tells the agent to write the result after the handoff", () => {
  const { o, R } = setup();
  const b = o("node", "brief", R, "a").out;
  expect(b).toMatch(/orch node result .* a --verdict full\|partial\|blocked --summary/);
  expect(b).toMatch(/right after it/);
  expect(b).toMatch(/only when the result says partial, blocked or has a follow_up/);
});
