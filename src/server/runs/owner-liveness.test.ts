import { describe, expect, test } from "bun:test";

import { findStaleProcs, LIVENESS_MS, MAX_BACKOFF_MS, parseEtime, reapStale, reconcileArgs, reconcileOnce, shouldReconcile } from "./run-reconciler";
import type { RunSchedule } from "./run-reconciler";

describe("reconciler owner verification", () => {
  test("the sync command carries --no-retry and --verify-owners", () => {
    const args = reconcileArgs("run-1");
    expect(args.slice(2)).toEqual(["run", "sync", "run-1", "--no-retry", "--verify-owners", "--lock"]);
  });
  test("a pass calls the injected spawner once per running run", async () => {
    const seen: string[] = [];
    const n = await reconcileOnce({ runningRunIds: () => ["a", "b"], spawn: async (id) => { seen.push(id); return { code: 0, stderr: "" }; } }, () => {});
    expect(n).toBe(2);
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("reconciler schedule", () => {
  test("an unchanged run without a running node is skipped until the liveness interval", async () => {
    let t = 1_000_000;
    const schedule = new Map<string, RunSchedule>();
    const deps = { runningRunIds: () => ["r"], spawn: async () => ({ code: 0, stderr: "" }), signature: () => "sig", hasRunningNode: () => false, schedule, now: () => t };
    expect(await reconcileOnce(deps, () => {})).toBe(1);
    t += 30_000;
    expect(await reconcileOnce(deps, () => {})).toBe(0);
    t += LIVENESS_MS;
    expect(await reconcileOnce(deps, () => {})).toBe(1);
  });
  test("a changed run, or one with a running node, is reconciled every pass", async () => {
    let sig = "a";
    const schedule = new Map<string, RunSchedule>();
    const deps = { runningRunIds: () => ["r"], spawn: async () => ({ code: 0, stderr: "" }), signature: () => sig, hasRunningNode: () => false, schedule, now: () => 5 };
    await reconcileOnce(deps, () => {});
    sig = "b";
    expect(await reconcileOnce(deps, () => {})).toBe(1);
    expect(await reconcileOnce({ ...deps, hasRunningNode: () => true }, () => {})).toBe(1);
  });
  test("a timeout doubles the run's interval up to 5 min, a success resets it, and the log line is timestamped", async () => {
    let t = 0;
    let code = 137;
    const lines: string[] = [];
    const schedule = new Map<string, RunSchedule>();
    const deps = { runningRunIds: () => ["r"], spawn: async () => ({ code, stderr: "killed" }), signature: () => null, hasRunningNode: () => true, schedule, now: () => t };
    await reconcileOnce(deps, (l) => lines.push(l));
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z run reconcile r failed \(137\)/);
    expect(schedule.get("r")?.intervalMs).toBe(60_000);
    t += 30_000;
    expect(await reconcileOnce(deps, () => {})).toBe(0);
    for (let i = 0; i < 6; i++) {
      t = schedule.get("r")?.nextAt ?? t;
      await reconcileOnce(deps, () => {});
    }
    expect(schedule.get("r")?.intervalMs).toBe(MAX_BACKOFF_MS);
    code = 0;
    t = schedule.get("r")?.nextAt ?? t;
    await reconcileOnce(deps, () => {});
    expect(schedule.get("r")?.intervalMs).toBe(30_000);
  });
  test("a run already in flight is not started again", () => {
    const s: RunSchedule = { okSignature: null, lastRunAt: 0, intervalMs: 30_000, nextAt: 0, inFlight: true };
    expect(shouldReconcile(s, "x", true, 10)).toBe(false);
  });
});

describe("reaper", () => {
  const ps = [
    "  101   100  02:36:10 bash /x/dispatch.sh run sync abc --no-retry",
    "  102   102     00:30 bash /x/dispatch.sh run sync abc --no-retry",
    "  103   103  1-00:00:01 bash /x/dispatch.sh harness list --json",
    "  104   104  05:00:00 vim dispatch.sh notes",
  ].join("\n");
  test("parseEtime", () => {
    expect(parseEtime("02:36:10")).toBe(9370);
    expect(parseEtime("1-00:00:01")).toBe(86401);
    expect(parseEtime("00:30")).toBe(30);
  });
  test("only old sync and harness list processes are stale", () => {
    expect(findStaleProcs(ps, 600, 1).map((p) => p.pid)).toEqual([101, 103]);
  });
  test("a stale probe in the server's own process group is killed alone, never by group", () => {
    const own = ["  4242   500     05:00 bun src/server/main.ts", "  4300   500  01:00:00 bash /x/dispatch.sh harness list --json", "  4400   600  01:00:00 bash /x/dispatch.sh run sync"].join("\n");
    const found = findStaleProcs(own, 600, 4242);
    expect(found.map((p) => [p.pid, p.pgid])).toEqual([[4300, 0], [4400, 600]]);
  });
  test("reapStale kills the process group and logs it", async () => {
    const killed: number[] = [];
    const lines: string[] = [];
    const n = await reapStale({ ps: async () => ps, kill: (pgid) => killed.push(pgid) }, (l) => lines.push(l));
    expect(n).toBe(2);
    expect(killed).toEqual([100, 103]);
    expect(lines[0]).toContain("reaped pid 101");
  });
});
