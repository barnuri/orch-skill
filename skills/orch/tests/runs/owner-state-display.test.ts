import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, readJson, fakeBin, ndjson, autoCleanup } from "../helpers";
autoCleanup();

// Unknown, unbound and no owner are three different states. Each prints its own exact text.
const mk = (extra: Record<string, string> = {}) => {
  const bin = fakeBin({ opencode: "exit 1" });
  const home = seedHome();
  const env: Record<string, string | undefined> = {
    ORCH_OPENCODE_DB: "/nonexistent/opencode.db", PATH: `${bin}:${process.env.PATH}`, ORCH_OWNER_CALL_TIMEOUT: "5", ORCH_OWNER_CACHE_SECS: "0",
    ORCH_OWNER_TOTAL_SECS: "120", ORCH_OWNER_BIND_SECS: "0", ORCH_UNOWNED_SECS: "99999", OPENCODE_SESSION_ID: "ses_parent", ...extra,
  };
  const o = orch(home, env);
  const pend = (child: string, title: string, offsetMs: number) => {
    mkdirSync(join(home, "owners/pending"), { recursive: true });
    writeFileSync(join(home, "owners/pending", `${child}.json`), JSON.stringify({ child, parent: "ses_parent", title, created: "2026-01-01T00:00:00Z", created_ms: Date.now() + offsetMs }));
  };
  const fbFor = (run: string, node: string) => {
    const dir = join(home, "feedback");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))).filter((x: any) => x.run_id === run && x.node_id === node);
  };
  return { home, o, pend, fbFor, nf: (run: string, id: string) => nodeOf(home, run, id) };
};
const L = (...r: object[]) => ndjson(r);
const runningAgent = (id: string, label: string, owner = "agent (spawned)") => [{ op: "add", id, label }, { op: "update", id, status: "running", owner }];
const lineOf = (t: ReturnType<typeof mk>, R: string, id: string) =>
  t.o("run", "status", R).out.split("\n").find((l: string) => l.startsWith(`running ${id}:`)) ?? "";

test("status line prints unknown, unbound, no owner and not checked as distinct exact texts", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(
    ...runningAgent("unk", "Unknown node", "agent ses_k123456789ab (spawned)"),
    ...runningAgent("tie", "Tie node"),
    { op: "add", id: "none", label: "No owner node" }, { op: "update", id: "none", status: "running" },
  ), "node", "batch", R);
  t.pend("ses_t1", "qqq", 4000);
  t.pend("ses_t2", "www", 4500);
  t.o("node", "bind-owners", "--run", R);
  t.o("node", "verify-owners", R);

  expect(t.nf(R, "unk").owner_state).toBe("unknown");
  expect(lineOf(t, R, "unk")).toMatch(/\[owner_state: unknown, owner_reason: .*ses_k123456789ab/);
  expect(lineOf(t, R, "tie")).toMatch(/\[owner_state: unbound, owner_reason: .*ses_t1.*ses_t2/);
  expect(lineOf(t, R, "none")).toMatch(/\[UNOWNED: nothing is recorded as doing the work\]/);
  expect(lineOf(t, R, "none")).not.toMatch(/owner_state/);
}, 60000);

test("an owner text with no bind and no state prints owner not checked, and adds no feedback", () => {
  const t = mk({ ORCH_OWNER_BIND: "0" });
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("nc", "Not checked node")), "node", "batch", R);
  t.o("node", "bind-owners", "--run", R);

  expect(t.nf(R, "nc").owner_state ?? null).toBeNull();
  expect(lineOf(t, R, "nc")).toMatch(/\[owner not checked\]/);
  expect(lineOf(t, R, "nc")).not.toMatch(/UNOWNED|owner_state/);
  expect(t.fbFor(R, "nc").length).toBe(0);
}, 60000);

test("feedback keeps the first reason and stays one item when the reason changes between polls", () => {
  const t = mk();
  const R = t.o("run", "start", "fb").out.trim();
  t.o.in(L(...runningAgent("alpha", "Alpha")), "node", "batch", R);
  t.pend("ses_t1", "qqq", 4000);
  t.pend("ses_t2", "www", 4500);
  t.o("node", "bind-owners", "--run", R);
  const first = t.fbFor(R, "alpha");
  expect(first.length).toBe(1);

  t.pend("ses_t3", "eee", 4800);
  t.o("node", "bind-owners", "--run", R);
  t.o("node", "bind-owners", "--run", R);

  const after = t.fbFor(R, "alpha");
  expect(after.length).toBe(1);
  expect(after[0].text).toBe(first[0].text);
  expect(after[0].text).not.toMatch(/ses_t3/);
  expect(t.nf(R, "alpha").owner_reason).toMatch(/ses_t3/);
}, 60000);

test("the same node id in two runs gets one feedback item per run", () => {
  const t = mk({ ORCH_UNOWNED_SECS: "0" });
  const R1 = t.o("run", "start", "fb1").out.trim();
  const R2 = t.o("run", "start", "fb2").out.trim();
  t.o.in(L({ op: "add", id: "y", label: "Y node" }, { op: "update", id: "y", status: "running" }), "node", "batch", R1);
  t.o.in(L({ op: "add", id: "y", label: "Y node" }, { op: "update", id: "y", status: "running" }), "node", "batch", R2);
  t.o("node", "bind-owners", "--run", R1);
  t.o("node", "bind-owners", "--run", R1);
  t.o("node", "bind-owners", "--run", R2);
  t.o("node", "bind-owners", "--run", R2);

  expect(t.fbFor(R1, "y").length).toBe(1);
  expect(t.fbFor(R2, "y").length).toBe(1);
}, 60000);
