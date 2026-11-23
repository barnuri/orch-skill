import { describe, expect, test } from "bun:test";

import { watchProcessAlive } from "./watch-liveness";

describe("watchProcessAlive", () => {
  test("a missing or invalid pid is not alive", () => {
    expect(watchProcessAlive(undefined, "watch-x")).toBe(false);
    expect(watchProcessAlive(0, "watch-x")).toBe(false);
    expect(watchProcessAlive(999_999_999, "watch-x")).toBe(false);
  });

  test("a live pid whose command line does not name the watch is not alive, and the answer is reused", () => {
    // The test runner is alive but is not `watch_run <id>`: the command line check must reject it.
    expect(watchProcessAlive(process.pid, "watch-no-such-id-0000")).toBe(false);
    expect(watchProcessAlive(process.pid, "watch-no-such-id-0000")).toBe(false);
  });
});
