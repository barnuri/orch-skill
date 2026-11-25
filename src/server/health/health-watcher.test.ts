import { describe, expect, test } from "bun:test";

import { TempHome } from "../test-support/temp-home";
import type { HealthDeps, SpawnResult } from "./health-watcher";
import { HealthWatcher, MAX_BACKOFF_MS, RECHECK_UNCHANGED_MS, ensureMonitors, findHealthMonitor, healthEverySec, parseHealth } from "./health-watcher";
import { orchPaths } from "../files/paths";

const RUN = "20261115-100000-abcd";

function report(run = RUN, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    run,
    at: "2026-11-15T10:00:00Z",
    max_parallel: 3,
    running: 1,
    slots: 2,
    nodes: [{ id: "a", status: "running", health: "stalled", owner_id: "ses_1", last_activity: "2026-11-15T09:40:00Z", idle_min: 20, note: "quiet" }],
    ready: ["b"],
    changes: [],
    ...extra,
  });
}

interface Harness {
  deps: HealthDeps;
  calls: string[][];
  clock: { t: number };
  sig: { value: string | null };
}

function harness(overrides: Partial<HealthDeps> = {}, result: () => Promise<SpawnResult> = async () => ({ code: 0, stdout: report(), stderr: "" })): Harness {
  const calls: string[][] = [];
  const clock = { t: 1_000_000 };
  const sig = { value: "1:1" as string | null };
  const deps: HealthDeps = {
    runningRunIds: () => [RUN],
    signature: () => sig.value,
    monitor: () => ({ alive: false, text: null }),
    spawn: (args) => {
      calls.push([...args]);
      return result();
    },
    now: () => clock.t,
    log: () => {},
    ...overrides,
  };
  return { deps, calls, clock, sig };
}

describe("HealthWatcher", () => {
  test("skips a run whose state and events mtimes are unchanged", async () => {
    const h = harness();
    const w = new HealthWatcher(h.deps);
    await w.tick();
    await w.tick();
    expect(h.calls).toEqual([["run", "health", RUN, "--json"]]);
    expect(w.latest(RUN)?.health.ready).toEqual(["b"]);
    expect(w.latest(RUN)?.source).toBe("watcher");
    h.sig.value = "2:1";
    await w.tick();
    expect(h.calls.length).toBe(2);
  });

  test("re-checks an unchanged run after RECHECK_UNCHANGED_MS, so a stall still surfaces", async () => {
    const h = harness();
    const w = new HealthWatcher(h.deps);
    await w.tick();
    h.clock.t += RECHECK_UNCHANGED_MS;
    await w.tick();
    expect(h.calls.length).toBe(2);
  });

  test("never overlaps a run with itself", async () => {
    let release: (r: SpawnResult) => void = () => {};
    const h = harness({}, () => new Promise<SpawnResult>((done) => (release = done)));
    const w = new HealthWatcher(h.deps);
    const first = w.check(RUN, true);
    const second = w.check(RUN, true);
    const sweep = w.tick();
    expect(h.calls.length).toBe(1);
    release({ code: 0, stdout: report(), stderr: "" });
    await Promise.all([first, second, sweep]);
    // The forced check that arrived mid-flight runs once more afterwards, still one at a time.
    await Bun.sleep(0);
    expect(h.calls.length).toBe(2);
    release({ code: 0, stdout: report(), stderr: "" });
  });

  test("backs off on timeout, doubling up to the cap, and resets on success", async () => {
    let code = 137;
    const h = harness({}, async () => ({ code, stdout: code === 0 ? report() : "", stderr: "killed" }));
    const w = new HealthWatcher(h.deps);
    await w.check(RUN);
    expect(h.calls.length).toBe(1);
    await w.check(RUN, true);
    expect(h.calls.length).toBe(1);
    h.clock.t += 30_000;
    await w.check(RUN);
    expect(h.calls.length).toBe(2);
    h.clock.t += 30_000;
    await w.check(RUN);
    expect(h.calls.length).toBe(2);
    h.clock.t += 30_000;
    await w.check(RUN);
    expect(h.calls.length).toBe(3);
    for (let i = 0; i < 10; i += 1) {
      h.clock.t += MAX_BACKOFF_MS;
      await w.check(RUN);
    }
    expect(h.calls.length).toBe(13);
    code = 0;
    h.clock.t += MAX_BACKOFF_MS;
    await w.check(RUN);
    expect(w.latest(RUN)?.health.run).toBe(RUN);
    h.sig.value = "changed";
    await w.check(RUN);
    expect(h.calls.length).toBe(15);
  });

  test("a live health monitor is only read: the watcher runs no pass of its own", async () => {
    const h = harness({ monitor: () => ({ alive: true, text: report(RUN, { slots: 0 }) }) });
    const w = new HealthWatcher(h.deps);
    await w.tick();
    await w.check(RUN, true);
    expect(h.calls).toEqual([]);
    expect(w.latest(RUN)?.source).toBe("monitor");
    expect(w.latest(RUN)?.health.slots).toBe(0);
  });

  test("summary() counts the running runs' cached results and never spawns", async () => {
    const h = harness({ runningRunIds: () => [RUN, "other"] });
    const w = new HealthWatcher(h.deps);
    expect(w.summary()).toMatchObject({ running_runs: 2, stalled: 0, ready: 0, flagged_runs: [] });
    expect(h.calls.length).toBe(0);
    await w.check(RUN);
    expect(w.summary()).toMatchObject({ running_runs: 2, stalled: 1, dead: 0, ready: 1, flagged_runs: [RUN] });
    expect(h.calls.length).toBe(1);
  });

  test("summary() counts needs-user nodes apart and never flags a run for them", async () => {
    const nodes = [{ id: "g", status: "waiting", health: "needs-user", owner_id: null, last_activity: null, idle_min: null, note: "needs the user: x" }];
    const h = harness({ monitor: () => ({ alive: true, text: report(RUN, { nodes, ready: [] }) }) });
    const w = new HealthWatcher(h.deps);
    await w.check(RUN);
    expect(w.latest(RUN)?.health.nodes[0]?.health).toBe("needs-user");
    expect(w.summary()).toMatchObject({ needs_user: 1, stalled: 0, flagged_runs: [] });
  });

  test("read() runs one pass when nothing is cached, then answers from memory", async () => {
    const h = harness({ runningRunIds: () => [] });
    const w = new HealthWatcher(h.deps);
    expect((await w.read(RUN))?.health.nodes[0]?.health).toBe("stalled");
    await w.read(RUN);
    expect(h.calls.length).toBe(1);
  });
});

describe("health helpers", () => {
  test("parseHealth rejects text without the contract's shape", () => {
    expect(parseHealth("usage: dispatch.ts run …")).toBeNull();
    expect(parseHealth('{"run":"x"}')).toBeNull();
    expect(parseHealth(report())?.nodes[0]?.idle_min).toBe(20);
  });

  test("ensureMonitors tolerates a dispatch without the subcommand", async () => {
    const lines: string[] = [];
    const ok = await ensureMonitors(async () => ({ code: 2, stdout: "", stderr: "unknown run subcommand: health" }), (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(lines.join("")).toContain("unavailable");
  });

  test("findHealthMonitor finds the run's live monitor and its newest output", async () => {
    const home = TempHome.create();
    try {
      const write = (id: string, name: string, pid: number, text: string): void => {
        home.write(`watches/${id}/spec.json`, JSON.stringify({ id, name }));
        home.write(`watches/${id}/state.json`, JSON.stringify({ id, status: "running", pid }));
        home.write(`watches/${id}/events.jsonl`, `${JSON.stringify({ n: 1, ts: "t", text: "old" })}\n${JSON.stringify({ n: 2, ts: "t", text })}\n`);
      };
      // A live process whose command line names the watch, as a real watch's `watch_run <id>` does.
      const proc = Bun.spawn(["sh", "-c", "sleep 600; :", "watch_run", "watch-2"], { stdout: "ignore", stderr: "ignore" });
      try {
        write("watch-1", "health:other-run", proc.pid, "x");
        expect(findHealthMonitor(home.path, RUN)).toEqual({ alive: false, text: null });
        // A pid that answers but is not this watch (reused by another process) is not alive.
        write("watch-2", `health:${RUN}`, process.pid, report());
        // The first call starts an async `ps` and trusts the pid; once ps answers, the reused pid is rejected.
        findHealthMonitor(home.path, RUN);
        await Bun.sleep(300);
        expect(findHealthMonitor(home.path, RUN).alive).toBe(false);
        write("watch-2", `health:${RUN}`, proc.pid, report());
        const found = findHealthMonitor(home.path, RUN);
        expect(found.alive).toBe(true);
        expect(parseHealth(found.text)?.run).toBe(RUN);
      } finally {
        proc.kill();
      }
    } finally {
      home.dispose();
    }
  });

  test("healthEverySec: env, then settings, then 30", () => {
    const home = TempHome.create();
    try {
      const paths = orchPaths(home.path);
      expect(healthEverySec(paths, {})).toBe(30);
      home.write("profiles.json", JSON.stringify({ settings: { health_every_sec: 45 }, profiles: {} }));
      expect(healthEverySec(paths, {})).toBe(45);
      expect(healthEverySec(paths, { ORCH_HEALTH_EVERY_SEC: "12" })).toBe(12);
    } finally {
      home.dispose();
    }
  });
});
