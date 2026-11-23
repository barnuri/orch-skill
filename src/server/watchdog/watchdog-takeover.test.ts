// test-tier: slow (fake-dispatch processes)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { WatchdogAction } from "../../shared/types/watchdog";
import { TempHome } from "../test-support/temp-home";
import { actionsLog, orchestratorAbsent, TAKEOVER_EVERY_MS, TAKEOVER_MAX_ATTEMPTS, WatchdogService } from "./watchdog-service";

const FAKE = resolve(import.meta.dir, "../test-support/fake-dispatch.ts");
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
const T0 = Date.parse("2026-11-23T10:00:00Z");
const RUN = "tk1";

interface Coordinator { unreachable: unknown }

function fixture(): {
  home: TempHome;
  clock: { ms: number };
  set(nodes: Node[], patch?: Record<string, unknown>): void;
  tick(): Promise<void>;
  takeover(): WatchdogAction[];
  calls(): string[];
} {
  const home = TempHome.create();
  const clock = { ms: T0 };
  const dog = new WatchdogService(home.path, {
    now: () => new Date(clock.ms),
    log: () => undefined,
    health: () => null,
    pidAlive: () => true,
  });
  return {
    home,
    clock,
    set: (nodes, patch = {}) => home.write(`runs/${RUN}/state.json`, JSON.stringify({ run_id: RUN, status: "running", auto_dispatch: false, nodes, edges: [], ...patch })),
    tick: async () => {
      dog.engine.evaluate(RUN);
      await Promise.all([...dog.inflight, ...dog.engine.inflight]);
      clock.ms += TAKEOVER_EVERY_MS + 1;
    },
    takeover: () => (existsSync(actionsLog(home.path)) ? readFileSync(actionsLog(home.path), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as WatchdogAction) : []).filter((a) => a.rule === "takeover"),
    calls: () => (existsSync(home.resolve("fake-dispatch.actions")) ? readFileSync(home.resolve("fake-dispatch.actions"), "utf8").split("\n").filter((l) => l !== "") : []),
  };
}

const absent: Record<string, unknown> = { coordinator: null };
const reachable: Coordinator = { unreachable: null };

describe("orchestrator absence: who may take over", () => {
  test("no coordinator and an unreachable coordinator are absent; a reachable one is not", () => {
    expect(orchestratorAbsent({ coordinator: null })).toBe(true);
    expect(orchestratorAbsent({})).toBe(true);
    expect(orchestratorAbsent({ coordinator: { unreachable: { reason: "pane gone", at: "x" } } })).toBe(true);
    expect(orchestratorAbsent({ coordinator: reachable })).toBe(false);
  });

  test("a reachable orchestrator gets no takeover action", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "error", error: "boom", attempts: [] }], { coordinator: reachable });
    await f.tick();
    expect(f.takeover()).toEqual([]);
    f.home.dispose();
  });

  test("an unreachable orchestrator is taken over", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "error", error: "boom", attempts: [] }], { coordinator: { unreachable: { reason: "pane gone", at: "x" } } });
    await f.tick();
    expect(f.takeover().map((a) => a.action)).toContain("run heal");
  });

  test("no coordinator: heal runs, and the failed node is retried", async () => {
    const f = fixture();
    f.set([{ id: "a", status: "error", error: "boom", attempts: [] }], absent);
    await f.tick();
    const actions = f.takeover().map((a) => `${a.action} ${a.node ?? ""}`.trim());
    expect(actions).toContain("run heal");
    expect(actions).toContain("node retry a");
    expect(f.calls()).toContain(`node retry ${RUN} a`);
  });
});

describe("takeover: blocked-user, retry, replace and routing", () => {
  test("blocked-user is untouched and its question is queued once", async () => {
    const f = fixture();
    f.set([{ id: "q", status: "blocked-user", needs_user: "Ship to prod?" }], absent);
    await f.tick();
    await f.tick();
    const tells = f.calls().filter((c) => c.startsWith(`node tell ${RUN} coordinator`));
    expect(tells.length).toBe(1);
    expect(tells[0]).toContain("Ship to prod?");
    expect(f.calls().filter((c) => c.includes(" q"))).toEqual(tells);
    expect(f.takeover().filter((a) => a.node === "q").map((a) => a.action)).toEqual(["node tell"]);
  });

  test("a new question on the same node is queued again", async () => {
    const f = fixture();
    f.set([{ id: "q", status: "blocked-user", needs_user: "Ship to prod?" }], absent);
    await f.tick();
    f.set([{ id: "q", status: "blocked-user", needs_user: "Ship to staging?" }], absent);
    await f.tick();
    expect(f.calls().filter((c) => c.startsWith(`node tell ${RUN} coordinator`)).length).toBe(2);
  });

  test("CLI or source errors, test failures and infra errors are not retried by the takeover", async () => {
    const f = fixture();
    f.set([
      { id: "c", status: "error", error: "TypeError: x is not a function", attempts: [] },
      { id: "t", status: "error", error: "3 tests failed", attempts: [] },
      { id: "i", status: "error", error: "process died", attempts: [] },
    ], absent);
    await f.tick();
    expect(f.takeover().filter((a) => a.action === "node retry" || a.action === "node replace")).toEqual([]);
  });

  test("after the attempts run out the node is replaced, not retried", async () => {
    const f = fixture();
    const attempts = Array.from({ length: TAKEOVER_MAX_ATTEMPTS }, () => ({ error: "boom" }));
    f.set([{ id: "a", status: "error", error: "boom", attempts }], absent);
    await f.tick();
    const actions = f.takeover().map((a) => `${a.action} ${a.node ?? ""}`.trim());
    expect(actions).toContain("node replace a");
    expect(actions).not.toContain("node retry a");
  });

  test("heal runs at most once per takeover interval", async () => {
    const calls: string[][] = [];
    const home = TempHome.create();
    const clock = { ms: T0 };
    const dog = new WatchdogService(home.path, {
      now: () => new Date(clock.ms),
      log: () => undefined,
      health: () => null,
      pidAlive: () => true,
      run: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    home.write(`runs/${RUN}/state.json`, JSON.stringify({ run_id: RUN, status: "running", auto_dispatch: false, nodes: [{ id: "a", status: "waiting" }], edges: [], ...absent }));
    const settle = async (): Promise<void> => {
      dog.engine.evaluate(RUN);
      await Promise.all([...dog.inflight, ...dog.engine.inflight]);
    };
    await settle();
    await settle();
    expect(calls.filter((a) => a[0] === "run" && a[1] === "heal").length).toBe(1);
    clock.ms += TAKEOVER_EVERY_MS + 1;
    await settle();
    expect(calls.filter((a) => a[0] === "run" && a[1] === "heal").length).toBe(2);
  });
});
