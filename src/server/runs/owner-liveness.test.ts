import { describe, expect, test } from "bun:test";

import { findStaleProcs, parseEtime, reapStale, reconcileArgs, reconcileOnce } from "./run-reconciler";

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
