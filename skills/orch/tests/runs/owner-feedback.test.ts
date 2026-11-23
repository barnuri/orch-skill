import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, readJson, fakeBin, ndjson, autoCleanup } from "../helpers";
autoCleanup();

const mk = () => {
  const bin = fakeBin({ opencode: "exit 1" });
  const home = seedHome();
  const env: Record<string, string | undefined> = {
    ORCH_OPENCODE_DB: "/nonexistent/opencode.db", PATH: `${bin}:${process.env.PATH}`, ORCH_OWNER_CALL_TIMEOUT: "5", ORCH_OWNER_CACHE_SECS: "0",
    ORCH_OWNER_TOTAL_SECS: "120", ORCH_OWNER_BIND_SECS: "0", ORCH_UNOWNED_SECS: "0", OPENCODE_SESSION_ID: "ses_parent",
  };
  const o = orch(home, env);
  const pend = (child: string, title: string, offsetMs: number) => {
    mkdirSync(join(home, "owners/pending"), { recursive: true });
    writeFileSync(join(home, "owners/pending", `${child}.json`), JSON.stringify({ child, parent: "ses_parent", title, created: "2026-01-01T00:00:00Z", created_ms: Date.now() + offsetMs }));
  };
  // Feedback items for one run and node. The feedback folder may not exist yet.
  const fbFor = (run: string, node: string) => {
    const dir = join(home, "feedback");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))).filter((x: any) => x.run_id === run && x.node_id === node);
  };
  return { home, o, pend, fbFor, nf: (run: string, id: string) => nodeOf(home, run, id) };
};
const L = (...r: object[]) => ndjson(r);
const runningAgent = (id: string, label: string, owner = "agent (spawned)") => [{ op: "add", id, label }, { op: "update", id, status: "running", owner }];

test("a tie leaves the node unbound and adds one feedback item, however many polls run", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("alpha", "Alpha")), "node", "batch", R);
  t.pend("ses_t1", "qqq", 4000);
  t.pend("ses_t2", "www", 4500);

  for (let poll = 0; poll < 3; poll++) t.o("node", "bind-owners", "--run", R);

  expect(t.nf(R, "alpha").owner_state).toBe("unbound");
  const items = t.fbFor(R, "alpha");
  expect(items.length).toBe(1);
  expect(items[0].run_id).toBe(R);
  expect(items[0].node_id).toBe("alpha");
  expect(items[0].text).toMatch(new RegExp(`run ${R} node alpha`));
  expect(items[0].text).toMatch(/ses_t1.*ses_t2|ses_t2.*ses_t1/);
}, 60000);

test("run status shows the exact owner_state and owner_reason of an unbound node, and its feedback is added once", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("alpha", "Alpha")), "node", "batch", R);
  t.pend("ses_t1", "qqq", 4000);
  t.pend("ses_t2", "www", 4500);

  t.o("node", "bind-owners", "--run", R);
  const status = t.o("run", "status", R).out;
  expect(status).toMatch(/running alpha:.*\[owner_state: unbound, owner_reason: .*ses_t1.*\]/);
  t.o("node", "bind-owners", "--run", R);
  expect(t.fbFor(R, "alpha").length).toBe(1);
}, 60000);

test("a running node with no owner shows owner_state unbound with its reason, and its feedback is added once", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L({ op: "add", id: "z", label: "Z node" }, { op: "update", id: "z", status: "running" }), "node", "batch", R);
  t.o("node", "bind-owners", "--run", R);
  t.o("node", "bind-owners", "--run", R);
  const line = t.o("run", "status", R).out.split("\n").find((l: string) => l.startsWith("running z:")) ?? "";
  expect(line).toMatch(/\[owner_state: unbound, owner_reason: running without an owner/);
  expect(t.fbFor(R, "z").length).toBe(1);
}, 60000);

test("a running node with no owner is unowned, and its feedback is added once", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L({ op: "add", id: "y", label: "Y node" }, { op: "update", id: "y", status: "running" }), "node", "batch", R);

  for (let poll = 0; poll < 3; poll++) t.o("node", "bind-owners", "--run", R);

  expect(t.nf(R, "y").owner_state).toBe("unbound");
  expect(t.nf(R, "y").owner_reason).toMatch(/running without an owner/);
  expect(t.fbFor(R, "y").length).toBe(1);
}, 60000);

test("feedback is per run and node: another node in the same run gets its own item", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("a1", "Aone"), ...runningAgent("a2", "Atwo")), "node", "batch", R);
  t.pend("ses_x1", "qqq", 1000);
  t.pend("ses_x2", "www", 1200);

  t.o("node", "bind-owners", "--run", R);
  t.o("node", "bind-owners", "--run", R);

  expect(t.fbFor(R, "a1").length).toBe(1);
  expect(t.fbFor(R, "a2").length).toBe(1);
}, 60000);

test("a bound node adds no feedback", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("lit", "Literal node", "agent ses_lit123 (spawned)")), "node", "batch", R);
  t.o("node", "bind-owners", "--run", R);

  expect(t.nf(R, "lit").owner_state ?? null).toBeNull();
  expect(t.fbFor(R, "lit").length).toBe(0);
}, 60000);

test("a bound owner the probe cannot read is unknown with its reason, and adds no feedback", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("k", "Known node", "agent ses_k123456789ab (spawned)")), "node", "batch", R);
  t.o("node", "bind-owners", "--run", R);
  t.o("node", "verify-owners", R);

  const n = t.nf(R, "k");
  expect(n.owner_state).toBe("unknown");
  expect(n.owner_reason).toMatch(/ses_k123456789ab/);
  const line = t.o("run", "status", R).out.split("\n").find((l: string) => l.startsWith("running k:")) ?? "";
  expect(line).toMatch(/\[owner_state: unknown, owner_reason: .*ses_k123456789ab/);
  expect(t.fbFor(R, "k").length).toBe(0);
}, 60000);
