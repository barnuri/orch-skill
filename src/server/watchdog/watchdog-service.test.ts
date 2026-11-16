// test-tier: slow (fake-dispatch processes)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { resolve } from "node:path";

import type { RunHealth } from "../../shared/types/run-health";
import type { WatchdogAction } from "../../shared/types/watchdog";
import { TempHome } from "../test-support/temp-home";
import { actionsLog, isInfraError, WatchdogService } from "./watchdog-service";

const FAKE = resolve(import.meta.dir, "../test-support/fake-dispatch.sh");
let prevDispatch: string | undefined;
beforeAll(() => {
  prevDispatch = process.env["ORCH_DISPATCH"];
  process.env["ORCH_DISPATCH"] = FAKE;
});
afterAll(() => {
  if (prevDispatch === undefined) {
    delete process.env["ORCH_DISPATCH"];
  } else {
    process.env["ORCH_DISPATCH"] = prevDispatch;
  }
});

type Node = Record<string, unknown> & { id: string; status: string };

const T0 = Date.parse("2026-11-16T10:00:00Z");

function stateOf(nodes: Node[], patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ run_id: "r1", status: "running", auto_dispatch: false, nodes, edges: [], ...patch });
}

interface Fixture {
  home: TempHome;
  dog: WatchdogService;
  clock: { ms: number };
  set(nodes: Node[], patch?: Record<string, unknown>): void;
  tick(): Promise<void>;
  actions(): string[];
  starts(): string[];
  log(): WatchdogAction[];
}

function fixture(opts: { health?: RunHealth | null; alive?: boolean } = {}): Fixture {
  const home = TempHome.create();
  const clock = { ms: T0 };
  const dog = new WatchdogService(home.path, {
    now: () => new Date(clock.ms),
    log: () => undefined,
    health: () => opts.health ?? null,
    pidAlive: () => opts.alive ?? true,
  });
  const lines = (name: string): string[] => {
    const f = home.resolve(name);
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l !== "") : [];
  };
  return {
    home,
    dog,
    clock,
    set: (nodes, patch) => home.write("runs/r1/state.json", stateOf(nodes, patch)),
    tick: async () => {
      dog.engine.evaluate("r1");
      await Promise.all([...dog.inflight, ...dog.engine.inflight]);
    },
    actions: () => lines("fake-dispatch.actions"),
    starts: () => lines("fake-dispatch.calls"),
    log: () => (existsSync(actionsLog(home.path)) ? readFileSync(actionsLog(home.path), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as WatchdogAction) : []),
  };
}

function health(nodes: { id: string; health: RunHealth["nodes"][number]["health"]; idle_min?: number }[]): RunHealth {
  return {
    run: "r1",
    at: "",
    max_parallel: 4,
    running: 1,
    slots: 3,
    nodes: nodes.map((n) => ({ id: n.id, status: "running", health: n.health, owner_id: null, last_activity: null, idle_min: n.idle_min ?? null, note: null })),
    ready: [],
    changes: [],
  };
}

describe("watchdog", () => {
  test("flags clear once their cause is gone, even without a new state change", async () => {
    const f = fixture();
    f.home.write("watchdog/r1/claims/retry-a", "x\n");
    f.set([{ id: "a", status: "running" }]);
    await f.tick();
    f.set([{ id: "a", status: "error", error: "process died", attempts: [] }]);
    await f.tick();
    expect(f.dog.status().flags.map((x) => `${x.node}:${x.rule}`)).toEqual(["a:infra-retry"]);
    f.set([{ id: "a", status: "running", attempts: [{}] }]);
    expect(f.dog.status().flags).toEqual([]);
    f.home.dispose();
  });

  test("an unverified flag clears once handoff.md exists, without a new state change", async () => {
    const f = fixture();
    f.home.write("watchdog/r1/claims/requeue-a", "x\n");
    f.set([{ id: "a", status: "running" }]);
    await f.tick();
    f.set([{ id: "a", status: "done", attempts: [] }]);
    await f.tick();
    expect(f.dog.status().flags.map((x) => `${x.node}:${x.rule}`)).toEqual(["a:unverified"]);
    f.home.write("runs/r1/out/a/handoff.md", "done\n");
    expect(f.dog.status().flags).toEqual([]);
    f.home.dispose();
  });

  test("coordinator hook: sweeps an unreachable coordinator, throttled, and skips a healthy one", async () => {
    const f = fixture();
    const sweeps = (): string[] => {
      const file = f.home.resolve("fake-dispatch.sweeps");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : [];
    };
    f.set([{ id: "a", status: "running" }], { coordinator: { pane_id: "p1", unreachable: null } });
    await f.tick();
    expect(sweeps()).toEqual([]);
    f.set([{ id: "a", status: "running" }], { coordinator: { pane_id: "p1", unreachable: { reason: "gone", at: "t" } } });
    await f.tick();
    expect(sweeps()).toEqual(["run messages r1 retry"]);
    await f.tick();
    expect(sweeps().length).toBe(1);
    f.clock.ms += 25_000;
    await f.tick();
    expect(sweeps().length).toBe(2);
    f.home.dispose();
  });

  test("coordinator hook: a reachable coordinator with a pending ask is swept", async () => {
    const f = fixture();
    f.home.write("runs/r1/inbox/orch/m1.json", JSON.stringify({ id: "m1", kind: "ask", delivered_at: null, status: "pending" }));
    f.set([{ id: "a", status: "running" }], { coordinator: { pane_id: "p1", unreachable: null } });
    await f.tick();
    expect(existsSync(f.home.resolve("fake-dispatch.sweeps"))).toBe(true);
    f.home.dispose();
  });

  test("rule 1: runs the auto-dispatch engine for ready nodes", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "waiting", profile: "p" }], { auto_dispatch: true });
    await f.tick();
    expect(f.starts()).toEqual(["r1 a p"]);
    f.home.dispose();
  });

  test("rule 2a: a node dead for 2 minutes is marked lost and retried once, then flagged", async () => {
    const f = fixture({ alive: false });
    f.home.write("jobs/j1/pid", "999999\n");
    f.set([{ id: "a", status: "running", job_id: "j1", owner_kind: "job", attempts: [] }]);
    await f.tick();
    expect(f.actions()).toEqual([]);
    f.clock.ms += 60_000;
    await f.tick();
    expect(f.actions()).toEqual([]);
    f.clock.ms += 61_000;
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --error process died", "node retry r1 a"]);
    // The retried attempt dies too: no second retry, a flag instead.
    f.set([{ id: "a", status: "running", job_id: "j1", owner_kind: "job", attempts: [{}] }]);
    await f.tick();
    f.clock.ms += 121_000;
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --error process died", "node retry r1 a", "node update r1 a error --error process died"]);
    // The real update leaves the node in error; the flag belongs to that status.
    f.set([{ id: "a", status: "error", error: "process died", job_id: "j1", owner_kind: "job", attempts: [{}, {}] }]);
    expect(f.dog.status().flags.map((x) => `${x.node}:${x.rule}`)).toEqual(["a:lost"]);
    expect(f.dog.status().runs["r1"]?.retried).toBe(1);
    f.home.dispose();
  });

  test("rule 2a: a live process or a recorded exit is never lost", async () => {
    const f = fixture({ alive: true });
    f.home.write("jobs/j1/pid", "1\n");
    f.home.write("jobs/j2/pid", "999999\n");
    f.home.write("jobs/j2/exit_code", "0\n");
    f.set([{ id: "a", status: "running", job_id: "j1" }, { id: "b", status: "running", job_id: "j2" }]);
    await f.tick();
    f.clock.ms += 300_000;
    await f.tick();
    expect(f.actions()).toEqual([]);
    f.home.dispose();
  });

  test("rule 2: a live job pid is never lost or stalled, whatever health says", async () => {
    const f = fixture({ alive: true, health: health([{ id: "a", health: "dead" }, { id: "b", health: "stalled", idle_min: 40 }]) });
    f.home.write("jobs/j1/pid", "123\n");
    f.home.write("jobs/j2/pid", "124\n");
    f.set([
      { id: "a", status: "running", job_id: "j1", owner_kind: "session", owner_id: "ses_a" },
      { id: "b", status: "running", job_id: "j2", owner_kind: "job" },
    ]);
    await f.tick();
    f.clock.ms += 600_000;
    await f.tick();
    expect(f.actions()).toEqual([]);
    expect(f.log()).toEqual([]);
    expect(f.dog.status().flags).toEqual([]);
    f.home.dispose();
  });

  test("rule 2: a growing job log is never lost or stalled; a quiet one is, after 2 minutes", async () => {
    const f = fixture({ alive: false, health: health([{ id: "a", health: "stalled", idle_min: 30 }]) });
    f.home.write("jobs/j1/pid", "999999\n");
    const old = new Date(T0 - 3_600_000);
    const writeLog = (text: string, at: Date = old): void => {
      f.home.write("jobs/j1/log", text);
      utimesSync(f.home.resolve("jobs/j1/log"), at, at);
    };
    writeLog("a\n", new Date(T0));
    f.set([{ id: "a", status: "running", job_id: "j1", owner_kind: "job", attempts: [] }]);
    await f.tick();
    for (let i = 0; i < 4; i += 1) {
      f.clock.ms += 61_000;
      writeLog("a\n".repeat(i + 2));
      await f.tick();
    }
    expect(f.actions()).toEqual([]);
    expect(f.log()).toEqual([]);
    // The log stops growing: the dead pid counts from here, and the stall verdict now holds.
    f.clock.ms += 61_000;
    await f.tick();
    f.clock.ms += 121_000;
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --error process died", "node retry r1 a"]);
    f.home.dispose();
  });

  test("rule 2b: a job log written within stall_minutes keeps the node out of stalled", async () => {
    const f = fixture({ alive: false, health: health([{ id: "a", health: "stalled", idle_min: 20 }]) });
    f.home.write("jobs/j1/pid", "999999\n");
    f.home.write("jobs/j1/log", "x\n");
    const fresh = new Date(T0 - 60_000);
    utimesSync(f.home.resolve("jobs/j1/log"), fresh, fresh);
    f.set([{ id: "a", status: "running", job_id: "j1", owner_kind: "session", owner_id: "ses_1" }]);
    await f.tick();
    expect(f.log().filter((a) => a.rule === "stalled")).toEqual([]);
    f.home.dispose();
  });

  test("rule 2b: without a verdict a quiet node is stalled after stall_minutes", async () => {
    const f = fixture({ alive: false });
    f.set([{ id: "a", status: "running", owner_kind: "session", owner_id: "ses_1", updated: new Date(T0 - 16 * 60_000).toISOString() }]);
    await f.tick();
    expect(f.log().map((a) => `${a.rule}:${a.action}:${a.detail}`)).toEqual(["stalled:flag:idle 16 min"]);
    f.home.dispose();
  });

  test("rule 2b: a stalled node is flagged once and not touched", async () => {
    const f = fixture({ health: health([{ id: "a", health: "stalled", idle_min: 22 }]) });
    f.set([{ id: "a", status: "running", owner_kind: "session", owner_id: "ses_1" }]);
    await f.tick();
    await f.tick();
    expect(f.actions()).toEqual([]);
    const flags = f.log().filter((a) => a.rule === "stalled");
    expect(flags).toHaveLength(1);
    expect(flags[0]?.action).toBe("flag");
    expect(flags[0]?.detail).toBe("idle 22 min");
    expect(f.dog.status().flags.map((x) => x.rule)).toEqual(["stalled"]);
    f.home.dispose();
  });

  test("rule 3: done without handoff.md is re-queued once; with a handoff nothing happens", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "running" }, { id: "b", status: "running" }]);
    await f.tick();
    f.home.write("runs/r1/out/b/handoff.md", "# done\n");
    f.set([{ id: "a", status: "done", attempts: [] }, { id: "b", status: "done" }]);
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --force --error done without handoff", "node retry r1 a You ended early. Read your handoff and the task, continue, and write handoff.md"]);
    // The re-queued attempt again ends without a handoff: flagged, not re-queued.
    f.set([{ id: "a", status: "running", attempts: [{}] }, { id: "b", status: "done" }]);
    await f.tick();
    f.set([{ id: "a", status: "done", attempts: [{}] }, { id: "b", status: "done" }]);
    await f.tick();
    expect(f.actions()).toHaveLength(2);
    expect(f.dog.status().flags.map((x) => `${x.node}:${x.rule}`)).toEqual(["a:unverified"]);
    // The handoff shows up later: the stale flag clears on the next sweep, with no status change.
    f.home.write("runs/r1/out/a/handoff.md", "# late handoff\n");
    await f.tick();
    expect(f.dog.status().flags).toEqual([]);
    f.home.dispose();
  });

  test("rule 4: an infra error is retried once; a test failure never", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "running" }, { id: "b", status: "running" }]);
    await f.tick();
    f.set([{ id: "a", status: "error", error: "exit=unknown", attempts: [] }, { id: "b", status: "error", error: "3 tests failed" }]);
    await f.tick();
    expect(f.actions()).toEqual(["node retry r1 a"]);
    f.set([{ id: "a", status: "running", attempts: [{}] }, { id: "b", status: "error", error: "3 tests failed" }]);
    await f.tick();
    f.set([{ id: "a", status: "error", error: "dispatch exit 1", attempts: [{}] }, { id: "b", status: "error", error: "3 tests failed" }]);
    await f.tick();
    expect(f.actions()).toEqual(["node retry r1 a"]);
    expect(f.dog.status().flags.map((x) => `${x.node}:${x.rule}`)).toEqual(["a:infra-retry"]);
    f.home.dispose();
  });

  test("rule 9b: a node starting for over 3 minutes whose job is alive is stamped started, never marked stuck", async () => {
    const f = fixture({ alive: true });
    f.home.write("jobs/j1/pid", "1\n");
    f.set([{
      id: "a", status: "running", job_id: "j1", owner_kind: "job", attempts: [],
      dispatched_at: new Date(f.clock.ms).toISOString(), started_at: null, seg_open: true,
    }]);
    f.clock.ms += 400_000;
    await f.tick();
    expect(f.actions()).toEqual(["node started r1 a"]);
    f.home.dispose();
  });

  test("rule 9: a node starting for over 3 minutes is marked stuck and retried once, then flagged", async () => {
    const f = fixture({ alive: false });
    const starting = (attempts: unknown[]): Node => ({
      id: "a", status: "running", job_id: "j1", owner_kind: "job", attempts,
      dispatched_at: new Date(f.clock.ms).toISOString(), started_at: null, seg_open: true,
    });
    f.home.write("jobs/j1/pid", "1\n");
    f.set([starting([])]);
    f.clock.ms += 179_000;
    await f.tick();
    expect(f.actions()).toEqual([]);
    f.clock.ms += 2_000;
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --error stuck starting", "node retry r1 a"]);
    expect(isInfraError("stuck starting")).toBe(true);
    // Running for real (started_at set): never treated as starting.
    f.set([{ ...starting([{}]), started_at: new Date(f.clock.ms).toISOString() }]);
    f.clock.ms += 600_000;
    await f.tick();
    expect(f.actions()).toHaveLength(2);
    // The retried attempt is stuck too: no second retry, a flag instead.
    f.set([starting([{}])]);
    f.clock.ms += 181_000;
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --error stuck starting", "node retry r1 a", "node update r1 a error --error stuck starting"]);
    // The real update leaves the node in error; the flag belongs to that status.
    f.set([{ id: "a", status: "error", error: "stuck starting", attempts: [{}, {}] }]);
    expect(f.dog.status().flags.map((x) => `${x.node}:${x.rule}`)).toEqual(["a:starting"]);
    f.home.dispose();
  });

  test("rule 4: infra error classification", () => {
    expect(isInfraError("exit=unknown")).toBe(true);
    expect(isInfraError("dispatch exit 2")).toBe(true);
    expect(isInfraError("model unavailable: claude-x")).toBe(true);
    expect(isInfraError("process died")).toBe(true);
    expect(isInfraError("exit=1")).toBe(false);
    expect(isInfraError("tests failed after process died")).toBe(false);
    expect(isInfraError(null)).toBe(false);
  });

  test("rule 5: an auto_dispatch run with every node done is finished once", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "done" }, { id: "b", status: "done" }], { auto_dispatch: true });
    await f.tick();
    await f.tick();
    expect(f.actions()).toEqual(["run finish r1"]);
    expect(f.dog.status().runs["r1"]?.finished).toBe(1);
    f.home.dispose();
  });

  test("rule 5: a run without auto_dispatch is not finished", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "done" }]);
    await f.tick();
    expect(f.actions()).toEqual([]);
    f.home.dispose();
  });

  test("rule 6: every action is one JSON line in actions.log, and counters survive a restart", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "done" }], { auto_dispatch: true });
    await f.tick();
    const lines = f.log();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ run: "r1", node: null, rule: "finish", action: "run finish", rc: 0 });
    const again = new WatchdogService(f.home.path, { log: () => undefined });
    const status = again.status();
    expect(status.state).toBe("off");
    expect(status.runs["r1"]?.finished).toBe(1);
    expect(status.last_actions[0]?.rule).toBe("finish");
    f.home.dispose();
  });

  test("rule 8: every sweep runs node bind-owners for a run with a running node, at most once per interval", async () => {
    const f = fixture();
    const owners = (): string[] => (existsSync(f.home.resolve("fake-dispatch.owners")) ? readFileSync(f.home.resolve("fake-dispatch.owners"), "utf8").split("\n").filter((l) => l !== "") : []);
    f.set([{ id: "a", status: "running" }]);
    await f.tick();
    await f.tick();
    expect(owners()).toEqual(["node bind-owners --run r1"]);
    f.clock.ms += 30_000;
    await f.tick();
    expect(owners()).toEqual(["node bind-owners --run r1", "node bind-owners --run r1"]);
    expect(f.actions()).toEqual([]);
    expect(f.log()).toEqual([]);
    f.home.dispose();
  });

  test("rule 8: a run with only old finished nodes is backfilled once, then left alone", async () => {
    const f = fixture();
    const owners = (): string[] => (existsSync(f.home.resolve("fake-dispatch.owners")) ? readFileSync(f.home.resolve("fake-dispatch.owners"), "utf8").split("\n").filter((l) => l !== "") : []);
    f.set([{ id: "a", status: "done", updated: "2026-11-16T08:00:00Z" }, { id: "b", status: "pending" }]);
    await f.tick();
    f.clock.ms += 60_000;
    await f.tick();
    expect(owners()).toEqual(["node bind-owners --run r1"]);
    f.set([{ id: "a", status: "done", updated: new Date(f.clock.ms).toISOString() }, { id: "b", status: "pending" }]);
    f.clock.ms += 60_000;
    await f.tick();
    expect(owners()).toEqual(["node bind-owners --run r1", "node bind-owners --run r1"]);
    f.home.dispose();
  });

  test("rule 8: a job-bound session node is judged by its job: a dead job pid is lost", async () => {
    const f = fixture({ alive: false });
    f.home.write("jobs/j1/pid", "999999\n");
    f.home.write("jobs/j1/log", "x\n");
    utimesSync(f.home.resolve("jobs/j1/log"), new Date(T0 - 600_000), new Date(T0 - 600_000));
    f.set([{ id: "a", status: "running", job_id: "j1", owner_kind: "session", owner_id: "ses_x", owner_bind: "job" }]);
    await f.tick();
    f.clock.ms += 130_000;
    await f.tick();
    expect(f.actions()).toEqual(["node update r1 a error --error process died", "node retry r1 a"]);
    f.home.dispose();
  });

  test("rule 7: paused and stopped runs are never acted on", async () => {
    for (const patch of [{ paused: true }, { stopped: true }]) {
      const f = fixture({ alive: false, health: health([{ id: "a", health: "stalled", idle_min: 99 }]) });
      f.home.write("jobs/j1/pid", "999999\n");
      f.set([{ id: "a", status: "running", job_id: "j1" }, { id: "b", status: "running" }], { auto_dispatch: true, ...patch });
      await f.tick();
      f.set([{ id: "a", status: "running", job_id: "j1" }, { id: "b", status: "error", error: "exit=unknown" }], { auto_dispatch: true, ...patch });
      f.clock.ms += 300_000;
      await f.tick();
      f.set([{ id: "a", status: "done" }, { id: "b", status: "done" }], { auto_dispatch: true, ...patch });
      await f.tick();
      expect(f.actions()).toEqual([]);
      expect(f.log()).toEqual([]);
      f.home.dispose();
    }
  });
});
