import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCleanup, runCleanup, snapshotCleanup, type HerdrPane } from "../../core/adapters/terminal-cleanup.ts";

const homes: string[] = [];
// The machine runs at load 35+ during shared test runs: give the cleanup hook more than bun's 5 s default.
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); }, 60_000);

// A temp orch home. Jobs, owner files and run states are real files; the herdr pane list is injected.
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "orch-cleanup-"));
  homes.push(h);
  mkdirSync(join(h, "jobs"), { recursive: true });
  mkdirSync(join(h, "runs"), { recursive: true });
  mkdirSync(join(h, "herdr", "tabs"), { recursive: true });
  return h;
}

const DEAD_PID = 2_147_483_646; // never a live process
const ALIVE_PID = process.pid;

interface JobOpts { tab: string; pane: string; exit?: number | null; pid?: number | null; owned?: boolean }
function job(h: string, id: string, o: JobOpts): void {
  const dir = join(h, "jobs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "herdr_tab"), `${o.tab}\n`);
  writeFileSync(join(dir, "herdr_pane"), `${o.pane}\n`);
  if (o.pid !== null && o.pid !== undefined) writeFileSync(join(dir, "pid"), String(o.pid));
  if (o.exit !== null && o.exit !== undefined) writeFileSync(join(dir, "exit_code"), `${o.exit}\n`);
  if (o.owned !== false) {
    writeFileSync(join(h, "herdr", "tabs", `${o.tab}.job`), `${dir}\n`);
  }
}

interface NodeOpts { status: string; job?: string | null; error?: string | null; covered_by?: string | null; needs_user?: string | null; origin?: string | null; attempts?: number; handoff?: boolean }
function run(h: string, id: string, o: { status?: string; paused?: boolean; coordinator?: { pane_id: string; unreachable?: unknown } | null; asks?: number; nodes: Record<string, NodeOpts> }): void {
  const dir = join(h, "runs", id);
  mkdirSync(join(dir, "out"), { recursive: true });
  const nodes = Object.entries(o.nodes).map(([nid, n]) => {
    const out = join(dir, "out", nid);
    if (n.handoff) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "handoff.md"), "done\n");
    }
    return {
      id: nid,
      status: n.status,
      job_id: n.job ?? null,
      error: n.error ?? null,
      covered_by: n.covered_by ?? null,
      needs_user: n.needs_user ?? null,
      origin: n.origin ?? null,
      attempts: Array.from({ length: n.attempts ?? 1 }, () => ({})),
      out_dir: out,
    };
  });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id, status: o.status ?? "running", paused: o.paused ?? false, coordinator: o.coordinator ?? null, nodes }));
  if (o.asks) {
    mkdirSync(join(dir, "inbox", "orch"), { recursive: true });
    for (let i = 0; i < o.asks; i++) writeFileSync(join(dir, "inbox", "orch", `ask${i}.json`), JSON.stringify({ kind: "ask", delivered_at: null }));
  }
}

const PANES = (list: Array<[string, string]>): HerdrPane[] => list.map(([pane_id, tab_id]) => ({ pane_id, tab_id }));

async function plan(h: string, panes: HerdrPane[], limit?: number) {
  return planCleanup(await snapshotCleanup(h, panes), limit);
}

const keptTab = (p: { keep: Array<{ tab: string; reasons: string[] }> }, tab: string): string[] => p.keep.find((k) => k.tab === tab)?.reasons ?? [];

describe("terminal cleanup: close is allowed only when nothing is attached", () => {
  test("an ended, owned, successful job tab closes", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { nodes: { n1: { status: "done", job: "j1", handoff: true } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([{ tab: "t1", jobs: ["j1"] }]);
    expect(p.keep).toEqual([]);
  });

  test("herdr down: empty plan, nothing to close", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    const snap = await snapshotCleanup(h, null);
    expect(snap.herdrUp).toBe(false);
    expect(planCleanup(snap)).toEqual({ close: [], tell: [], keep: [], unowned_tabs: 0, limited: 0 });
  });

  test("a live job pid keeps its tab even when its exit code is written", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0, pid: ALIVE_PID });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("live job j1");
  });

  test("a dead job with no exit code and no node is an orphan and closes", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", pid: DEAD_PID });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close.map((c) => c.tab)).toEqual(["t1"]);
  });

  test("a dead job with no exit code that a node still points at is kept", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", pid: DEAD_PID });
    run(h, "r1", { nodes: { n1: { status: "error", job: "j1", error: "crash" } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("has no exit code and node n1");
  });

  test("a running node keeps the tab of its job", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { nodes: { n1: { status: "running", job: "j1" } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("node n1 running");
  });

  test("the registered orchestrator's pane keeps its tab and every tab of its run", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    job(h, "j2", { tab: "t2", pane: "p2", exit: 0 });
    run(h, "r1", { coordinator: { pane_id: "orch-pane" }, nodes: { n1: { status: "done", job: "j1", handoff: true }, n2: { status: "done", job: "j2", handoff: true } } });
    const p = await plan(h, PANES([["p1", "t1"], ["p2", "t2"], ["orch-pane", "t9"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("orchestrator active for run r1");
    expect(keptTab(p, "t2").join(";")).toContain("orchestrator active for run r1");
  });

  test("an unreachable orchestrator does not protect its run", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { coordinator: { pane_id: "gone", unreachable: { reason: "x" } }, nodes: { n1: { status: "done", job: "j1", handoff: true } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([{ tab: "t1", jobs: ["j1"] }]);
  });

  test("a node that waits for the user keeps its tab (blocked-user or needs_user)", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    job(h, "j2", { tab: "t2", pane: "p2", exit: 0 });
    run(h, "r1", { nodes: { n1: { status: "blocked-user", job: "j1", needs_user: "approve?" }, n2: { status: "done", job: "j2", needs_user: "still open" } } });
    const p = await plan(h, PANES([["p1", "t1"], ["p2", "t2"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("waits for the user");
    expect(keptTab(p, "t2").join(";")).toContain("waits for the user");
  });

  test("pending asks keep every tab of the run", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { asks: 1, nodes: { n1: { status: "done", job: "j1", handoff: true } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("pending ask");
  });

  test("a failed job keeps its pane until its result is recorded on the node", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 1 });
    job(h, "j2", { tab: "t2", pane: "p2", exit: 1 });
    run(h, "r1", { nodes: { n1: { status: "running", job: "j1" }, n2: { status: "error", job: "j2", error: "tests failed" } } });
    const p = await plan(h, PANES([["p1", "t1"], ["p2", "t2"]]));
    expect(p.close).toEqual([{ tab: "t2", jobs: ["j2"] }]);
    expect(keptTab(p, "t1").join(";")).toContain("node n1 running");
  });

  test("a failed job whose node has no error and no handoff keeps its pane", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 2 });
    run(h, "r1", { nodes: { n1: { status: "error", job: "j1" } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("result not recorded");
  });

  test("a stop signal exit (130) is not a failure and closes", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 130 });
    run(h, "r1", { nodes: { n1: { status: "stopped", job: "j1" } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.close).toEqual([{ tab: "t1", jobs: ["j1"] }]);
  });

  test("a pane in the tab that no orch job owns keeps the tab", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { nodes: { n1: { status: "done", job: "j1", handoff: true } } });
    const p = await plan(h, PANES([["p1", "t1"], ["p-foreign", "t1"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("foreign pane");
  });

  test("a tab whose owner file names another job, or none, is never closed", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0, owned: false });
    job(h, "j2", { tab: "t2", pane: "p2", exit: 0 });
    writeFileSync(join(h, "herdr", "tabs", "t2.job"), join(h, "jobs", "someone-else") + "\n");
    const p = await plan(h, PANES([["p1", "t1"], ["p2", "t2"]]));
    expect(p.close).toEqual([]);
    expect(keptTab(p, "t1").join(";")).toContain("not owned");
    expect(keptTab(p, "t2").join(";")).toContain("not owned");
  });

  test("a tab with no orch job is counted, never closed", async () => {
    const h = home();
    const p = await plan(h, PANES([["p-x", "t-x"]]));
    expect(p.close).toEqual([]);
    expect(p.keep).toEqual([]);
    expect(p.unowned_tabs).toBe(1);
  });

  test("the limit caps closes and messages together, closes first", async () => {
    const h = home();
    for (const i of [1, 2, 3]) {
      job(h, `j${i}`, { tab: `t${i}`, pane: `p${i}`, exit: 0 });
    }
    run(h, "r1", { nodes: { n1: { status: "done", job: "j1", handoff: true }, n2: { status: "done", job: "j2", handoff: true }, n3: { status: "done", job: "j3", handoff: true }, e1: { status: "error", error: "boom" } } });
    const p = await plan(h, PANES([["p1", "t1"], ["p2", "t2"], ["p3", "t3"]]), 2);
    expect(p.close.length).toBe(2);
    expect(p.tell.length).toBe(0);
    expect(p.limited).toBe(2);
  });
});

describe("terminal cleanup: stale node recovery", () => {
  test("an error node with no live job is sent to the orchestrator once", async () => {
    const h = home();
    run(h, "r1", { nodes: { e1: { status: "error", error: "model unavailable", attempts: 2 } } });
    const snap = await snapshotCleanup(h, PANES([]));
    const p = planCleanup(snap);
    expect(p.tell.map((t) => t.key)).toEqual(["r1/e1/error/2"]);
    const again = planCleanup({ ...snap, notified: new Set(p.tell.map((t) => t.key)) });
    expect(again.tell).toEqual([]);
  });

  test("an error node with a live job of its own is not sent", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", pid: ALIVE_PID });
    run(h, "r1", { nodes: { e1: { status: "error", job: "j1", error: "x" } } });
    const p = await plan(h, PANES([["p1", "t1"]]));
    expect(p.tell).toEqual([]);
  });

  test("engine (loop) nodes and nodes that need the user are never sent", async () => {
    const h = home();
    run(h, "r1", { nodes: { l1: { status: "error", error: "x", origin: "loop" }, u1: { status: "error", error: "x", needs_user: "pick one" } } });
    const p = await plan(h, PANES([]));
    expect(p.tell).toEqual([]);
  });

  test("a covered node whose replacement is done is not stale", async () => {
    const h = home();
    run(h, "r1", { nodes: { c1: { status: "covered", covered_by: "n2" }, n2: { status: "done", handoff: true } } });
    const p = await plan(h, PANES([]));
    expect(p.tell).toEqual([]);
  });

  test("a covered node whose replacement errored, or is missing, is sent", async () => {
    const h = home();
    run(h, "r1", { nodes: { c1: { status: "covered", covered_by: "n2" }, n2: { status: "error", error: "x" }, c2: { status: "covered", covered_by: "gone" } } });
    const p = await plan(h, PANES([]));
    const keys = p.tell.map((t) => t.key).sort();
    expect(keys).toContain("r1/c1/covered/n2");
    expect(keys).toContain("r1/c2/covered/gone");
  });

  test("a paused or finished run gets no messages", async () => {
    const h = home();
    run(h, "r-paused", { paused: true, nodes: { e1: { status: "error", error: "x" } } });
    run(h, "r-done", { status: "done", nodes: { e1: { status: "error", error: "x" } } });
    const p = await plan(h, PANES([]));
    expect(p.tell).toEqual([]);
  });
});

describe("terminal cleanup: apply re-checks before it acts", () => {
  test("a tab that became live between the plan and the apply is not closed", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { nodes: { n1: { status: "done", job: "j1", handoff: true } } });
    const panes = PANES([["p1", "t1"]]);
    const first = await snapshotCleanup(h, panes);
    // The job starts again before the apply re-reads the state.
    writeFileSync(join(h, "jobs", "j1", "pid"), String(ALIVE_PID));
    let calls = 0;
    const closed: string[] = [];
    const report = await runCleanup(h, { apply: true, panes }, {
      snapshot: async () => (calls++ === 0 ? first : snapshotCleanup(h, panes)),
      closeTab: async (_home, tab) => { closed.push(tab); return true; },
      dispatch: async () => 0,
    });
    expect(report.plan.close).toEqual([{ tab: "t1", jobs: ["j1"] }]);
    expect(closed).toEqual([]);
    expect(report.applied.closed).toEqual([]);
  });

  test("apply closes a safe tab, sends one message, and does not repeat it", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    job(h, "j2", { tab: "t2", pane: "p2", pid: ALIVE_PID });
    run(h, "r1", { nodes: { n1: { status: "done", job: "j1", handoff: true }, n2: { status: "running", job: "j2" }, e1: { status: "error", error: "boom" } } });
    const state = { panes: PANES([["p1", "t1"], ["p2", "t2"]]) };
    const told: string[][] = [];
    const deps = {
      closeTab: async (_home: string, tab: string) => { state.panes = state.panes.filter((p) => p.tab_id !== tab); return true; },
      dispatch: async (args: string[]) => { told.push(args); return 0; },
    };
    const r1 = await runCleanup(h, { apply: true, panes: state.panes }, deps);
    expect(r1.applied.closed).toEqual(["t1"]);
    expect(r1.applied.told).toEqual(["r1/e1"]);
    expect(told.length).toBe(1);
    expect(told[0]!.slice(0, 3)).toEqual(["node", "tell", "r1"]);

    const r2 = await runCleanup(h, { apply: true, panes: state.panes }, deps);
    expect(r2.applied.closed).toEqual([]); // t1 is gone from the pane list
    expect(r2.applied.told).toEqual([]); // dedupe: e1 was already told
    expect(told.length).toBe(1);
  });

  test("dry run never calls close or dispatch", async () => {
    const h = home();
    job(h, "j1", { tab: "t1", pane: "p1", exit: 0 });
    run(h, "r1", { nodes: { n1: { status: "done", job: "j1", handoff: true }, e1: { status: "error", error: "boom" } } });
    const calls: string[] = [];
    const r = await runCleanup(h, { apply: false, panes: PANES([["p1", "t1"]]) }, {
      closeTab: async () => { calls.push("close"); return true; },
      dispatch: async () => { calls.push("dispatch"); return 0; },
    });
    expect(calls).toEqual([]);
    expect(r.mode).toBe("dry-run");
    expect(r.plan.close.length).toBe(1);
    expect(r.plan.tell.length).toBe(1);
  });
});
