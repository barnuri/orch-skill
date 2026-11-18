// reapUnder stops only the processes whose HARNESS_ORCH_HOME is the given home.
// The throwaway process is bun, not /bin/sleep: macOS ps does not show the environment of system binaries.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { autoCleanup, tempDir } from "../helpers/index.ts";
import { alive, listHomeProcs, reapUnder } from "../lib/reap.ts";

autoCleanup();

test("reapUnder stops the process of its home and leaves other homes alone", async () => {
  const home = tempDir("orch-t-reap-");
  const other = tempDir("orch-t-reap-other-");
  const env = (h: string) => ({ ...process.env, HARNESS_ORCH_HOME: h }) as Record<string, string>;
  const mine = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { env: env(home), stdout: "ignore", stderr: "ignore" });
  const theirs = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { env: env(other), stdout: "ignore", stderr: "ignore" });
  try {
    await Bun.sleep(200);
    expect(listHomeProcs().some((p) => p.pid === mine.pid && p.home === home)).toBe(true);

    const killed = reapUnder(home);

    expect(killed).toEqual([mine.pid]);
    expect(alive(mine.pid)).toBe(false);
    expect(alive(theirs.pid)).toBe(true);
  } finally {
    try { theirs.kill(9); } catch {}
    await theirs.exited;
    try { mine.kill(9); } catch {}
  }
});

test("reapUnder returns an empty list when no process uses the home", () => {
  expect(reapUnder(join(tempDir("orch-t-empty-"), "none"))).toEqual([]);
});
