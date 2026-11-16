import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, runState, nodeOf, events, ndjson, normState, eventKeys, handoff, autoCleanup } from "../helpers";
autoCleanup();
const env = { CLAUDE_CODE_SESSION_ID: "batch-test" };
const mk = () => { const home = seedHome(); return { home, o: orch(home, env) }; };
const L = (...rows: object[]) => ndjson(rows);

test("mixed batch applies like single commands", () => {
  const { home, o } = mk();
  const R = o("run", "start", "batch demo").out.trim();
  const r = o.in('{"op":"add","id":"a","goal":"Alpha"}\n\n{"op":"add","id":"b","label":"Beta","after":["a"],"role":"planning","tier":"balance"}\n{"op":"update","id":"a","status":"running","owner":"coordinator"}\n{"op":"report","id":"a","note":"halfway","input_tokens":12,"usd":0.5}\n{"op":"update","id":"a","status":"done"}\n', "node", "batch", R);
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/^line 1: add a "Alpha" ok/m);
  expect(r.all).toMatch(/line 6: update a -> done ok/);
  expect(r.all).toMatch(/applied 5 op\(s\)/);
  const a = nodeOf(home, R, "a");
  expect([a.status, a.owner]).toEqual(["done", "coordinator"]);
  expect([a.report.note, a.report.input_tokens, a.report.usd]).toEqual(["halfway", 12, 0.5]);
  const b = nodeOf(home, R, "b");
  expect([b.role, b.tier]).toEqual(["planning", "balance"]);
  expect(runState(home, R).edges[0]).toEqual(["a", "b"]);
  expect(events(home, R).map((e) => e.kind).join(" ")).toBe("add add status note status note");
  expect(a.unverified).toBe(true);
  expect(r.all).toMatch(/done without handoff: a /);

  const RV = o("run", "start", "verify fallback").out.trim();
  o.in(L({ op: "add", id: "v", goal: "V" }, { op: "add", id: "w", goal: "W" }, { op: "update", id: "v", status: "done" }), "node", "batch", RV);
  handoff(home, RV, "w");
  o.in(L({ op: "update", id: "w", status: "done" }), "node", "batch", RV);
  expect(nodeOf(home, RV, "v").unverified).toBe(true);
  expect(nodeOf(home, RV, "w").unverified ?? null).toBeNull();

  const before = JSON.stringify(runState(home, R));
  const evBefore = events(home, R).length;
  const bad = o.in('{"op":"add","id":"c","goal":"Gamma"}\nnot json\n{"op":"update","id":"a","status":"waiting"}\n{"op":"add","id":"d","goal":"Delta","bogus":1}\n{"op":"report","id":"zz","note":"x"}\n{"op":"frob","id":"c"}\n', "node", "batch", R);
  expect(bad.rc).toBe(2);
  expect(bad.all).toMatch(/^line 2: /m);
  expect(bad.all).toMatch(/^line 3: node update: a is done/m);
  expect(bad.all).toMatch(/^line 4: unknown field\(s\) for add: bogus/m);
  expect(bad.all).toMatch(/^line 5: node zz: not in this run/m);
  expect(bad.all).toMatch(/^line 6: "op" must be add, report or update/m);
  expect(bad.all).toMatch(/5 invalid op\(s\) of 6; nothing applied/);
  expect(JSON.stringify(runState(home, R))).toBe(before);
  expect(events(home, R).length).toBe(evBefore);
  expect(o.in(L({ op: "add", id: "c", goal: "Gamma" }, { op: "add", id: "d", goal: "Delta", after: "c" }), "node", "batch", R, "--dry-run").rc).toBe(0);

  const f = join(home, "ops.jsonl");
  writeFileSync(f, L({ op: "add", id: "e", goal: "Eps" }, { op: "update", id: "e", status: "skipped" }));
  const b4 = JSON.stringify(runState(home, R));
  const dry = o("node", "batch", R, "--file", f, "--dry-run");
  expect(dry.rc).toBe(0);
  expect(dry.all).toMatch(/^line 2: would update e -> skipped/m);
  expect(dry.all).toMatch(/dry run, nothing applied/);
  expect(JSON.stringify(runState(home, R))).toBe(b4);
  expect(o("node", "batch", R, "--file", f).rc).toBe(0);
  expect(nodeOf(home, R, "e").status).toBe("skipped");
  expect(o.in("", "node", "batch", R, "--bogus").rc).toBe(2);
  expect(o.in("", "node", "batch", R).rc).toBe(2);
  expect(o.in("", "node", "batch", "no-such-run").rc).toBe(2);
});

test("batch equals single calls", () => {
  const { home, o } = mk();
  const ops = [
    { op: "add", id: "p", goal: "Plan" }, { op: "add", id: "i", goal: "Implement", after: "p", profile: "local-llm-fast", model: "m1" },
    { op: "add", id: "t", goal: "Tests", after: ["p"], plan_backed: true, acceptance: "green" },
    { op: "update", id: "p", status: "running", owner: "coordinator" }, { op: "report", id: "p", model: "opus", output_tokens: 7, note: "planned" },
    { op: "update", id: "p", status: "done" }, { op: "update", id: "i", status: "running", owner: "pid 1" },
    { op: "update", id: "i", status: "error", error: "boom" }, { op: "update", id: "t", status: "skipped" }, { op: "report", id: "i", usd: 1.25 },
  ];
  const RB = o("run", "start", "eq batch", "--id", "eq-batch").out.trim(); handoff(home, RB, "p");
  const RS = o("run", "start", "eq single", "--id", "eq-single").out.trim(); handoff(home, RS, "p");
  expect(o.in(L(...ops), "node", "batch", RB).rc).toBe(0);
  o("node", "add", RS, "p", "Plan");
  o("node", "add", RS, "i", "Implement", "--after", "p", "--profile", "local-llm-fast", "--model", "m1");
  o("node", "add", RS, "t", "Tests", "--after", "p", "--plan-backed", "--acceptance", "green");
  o("node", "update", RS, "p", "running", "--owner", "coordinator");
  o("node", "report", RS, "p", "--model", "opus", "--output-tokens", "7", "--note", "planned");
  o("node", "update", RS, "p", "done");
  o("node", "update", RS, "i", "running", "--owner", "pid 1");
  o("node", "update", RS, "i", "error", "--error", "boom");
  o("node", "update", RS, "t", "skipped");
  o("node", "report", RS, "i", "--usd", "1.25");
  expect(normState(home, RB)).toBe(normState(home, RS));
  expect(eventKeys(home, RB)).toBe(eventKeys(home, RS));
  const bad = L({ op: "update", id: "p", status: "waiting" }, { op: "report", id: "p" }, { op: "add", id: "p", goal: "x" },
    { op: "update", id: "t", status: "done", at: "2099-01-01T00:00:00Z" }, { op: "update", id: "t", status: "done", job: "nojob" });
  expect(o.in(bad, "node", "batch", RB).all).toMatch(/node batch: 5 invalid op\(s\) of 5/);
});

test("deps and continued runs", () => {
  const { home, o } = mk();
  const RC = o("run", "start", "carry src", "--id", "carry-src").out.trim();
  o("node", "add", RC, "a", "A"); o("node", "update", RC, "a", "done"); o("node", "add", RC, "b", "B");
  o("run", "carry", RC, "--id", "carry-dst");
  expect(o.in(L({ op: "add", id: "c", goal: "C", after: "a" }), "node", "batch", "carry-dst").rc).toBe(0);
  expect(nodeOf(home, "carry-dst", "c").label).toBe("C");

  const dops = [
    { op: "add", id: "a", goal: "A" }, { op: "add", id: "b", goal: "B" }, { op: "add", id: "g", goal: "Gate" },
    { op: "update", id: "b", after: ["a"] }, { op: "update", id: "g", after: "*", needs_user: "approve" },
    { op: "update", id: "a", status: "running", owner: "coordinator", needs_user: "look" }, { op: "update", id: "a", clear_needs_user: true },
    { op: "update", id: "b", after: "" }, { op: "update", id: "b", after: "a,g" },
  ];
  const DF = o("run", "start", "deps fast", "--id", "deps-fast").out.trim();
  const DS = o("run", "start", "deps single", "--id", "deps-single").out.trim();
  const r = o.in(L(...dops), "node", "batch", DF);
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/^line 5: update g ok/m);
  o("node", "add", DS, "a", "A"); o("node", "add", DS, "b", "B"); o("node", "add", DS, "g", "Gate");
  o("node", "update", DS, "b", "--after", "a");
  o("node", "update", DS, "g", "--after", "*", "--needs-user", "approve");
  o("node", "update", DS, "a", "running", "--owner", "coordinator", "--needs-user", "look");
  o("node", "update", DS, "a", "--clear-needs-user");
  o("node", "update", DS, "b", "--after", "");
  o("node", "update", DS, "b", "--after", "a,g");
  const g = nodeOf(home, DF, "g");
  expect([g.after_all, g.needs_user]).toEqual([true, "approve"]);
  expect(nodeOf(home, DF, "a").needs_user ?? null).toBeNull();
  expect(runState(home, DF).edges.map((e: string[]) => e.join(">")).join(" ")).toBe("a>b g>b");
  expect(normState(home, DF)).toBe(normState(home, DS));
  expect(eventKeys(home, DF)).toBe(eventKeys(home, DS));
  const dbad = [{ op: "update", id: "a", after: "a" }, { op: "update", id: "a", after: "zz" }, { op: "update", id: "a", after: "b" }, { op: "update", id: "a" }, { op: "update", id: "a", needs_user: "" }];
  const e1 = o.in(L(...dbad), "node", "batch", DF).all;
  expect(e1).toMatch(/^line 1: node update: a cannot depend on itself/m);
  expect(e1).toMatch(/^line 2: node update: dependency zz is not in run/m);
  expect(e1).toMatch(/^line 3: node update: --after b would make a cycle/m);
  expect(e1).toMatch(/^line 4: usage: dispatch.sh node update/m);
  expect(e1).toMatch(/^line 5: node update: --needs-user expects a reason/m);
  const singles = [["--after", "a"], ["--after", "zz"], ["--after", "b"], [], ["--needs-user", ""]].map((f) => o("node", "update", DF, "a", ...f).all).join("\n");
  for (const m of ["cannot depend on itself", "dependency zz is not in run", "would make a cycle", "usage: dispatch.sh node update", "--needs-user expects a reason"]) expect(singles).toMatch(m);
});

test("holds in batches", () => {
  const { home, o } = mk();
  const ops = [
    { op: "add", id: "a", goal: "A" }, { op: "add", id: "b", goal: "B" }, { op: "update", id: "a", hold: "until load < 4" },
    { op: "update", id: "b", hold: "later" }, { op: "update", id: "b", clear_hold: true }, { op: "update", id: "b", hold: "again" },
    { op: "update", id: "b", status: "running", owner: "coordinator" },
  ];
  const HF = o("run", "start", "hold fast", "--id", "hold-fast").out.trim();
  const HS = o("run", "start", "hold single", "--id", "hold-single").out.trim();
  expect(o.in(L(...ops), "node", "batch", HF).rc).toBe(0);
  o("node", "add", HS, "a", "A"); o("node", "add", HS, "b", "B");
  o("node", "update", HS, "a", "--hold", "until load < 4");
  o("node", "update", HS, "b", "--hold", "later");
  o("node", "update", HS, "b", "--clear-hold");
  o("node", "update", HS, "b", "--hold", "again");
  o("node", "update", HS, "b", "running", "--owner", "coordinator");
  expect(nodeOf(home, HF, "a").hold).toBe("until load < 4");
  expect(nodeOf(home, HF, "b").hold ?? null).toBeNull();
  expect(events(home, HF).filter((e) => e.kind === "hold").map((e) => e.note).join(",")).toBe("until load < 4,later,cleared,again");
  expect(normState(home, HF)).toBe(normState(home, HS));
  expect(eventKeys(home, HF)).toBe(eventKeys(home, HS));
  const h = o.in(L({ op: "update", id: "a", hold: "" }, { op: "update", id: "a", hold: "x", clear_hold: true }), "node", "batch", HF).all;
  expect(h).toMatch(/^line 1: node update: --hold expects a reason/m);
  expect(h).toMatch(/line 2: "hold" and "clear_hold" cannot be combined/);
});
