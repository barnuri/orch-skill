import { describe, expect, test } from "bun:test";

import { watchProcessAlive } from "./watch-liveness";

describe("watchProcessAlive", () => {
  test("a missing or invalid pid is not alive", () => {
    expect(watchProcessAlive(undefined, "watch-x")).toBe(false);
    expect(watchProcessAlive(0, "watch-x")).toBe(false);
    expect(watchProcessAlive(999_999_999, "watch-x")).toBe(false);
  });

  test("a live pid whose command line does not name the watch is not alive, and the answer is reused", async () => {
    // The test runner is alive but is not `watch_run <id>`: the command line check must reject it.
    // Without /proc the command line is read by an async `ps`, so the first call trusts the pid and the read lands soon after.
    const id = "watch-no-such-id-0000";
    for (let i = 0; i < 100 && watchProcessAlive(process.pid, id); i++) await new Promise((r) => setTimeout(r, 50));
    expect(watchProcessAlive(process.pid, id)).toBe(false);
    expect(watchProcessAlive(process.pid, "watch-no-such-id-0000")).toBe(false);
  });
});
