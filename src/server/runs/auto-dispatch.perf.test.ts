import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { RunEngine, type RunState } from "./auto-dispatch";

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

/** A finished run with a large node list, so each state.json is a few hundred KB like a real run. */
function bigFinishedRun(id: string): RunState {
  const nodes = Array.from({ length: 60 }, (_, i) => ({
    id: `n${i}`,
    status: "done",
    label: `Node ${i}`,
    profile: "p",
    finished: "2026-11-23T10:00:00.000Z",
    prompt: "x".repeat(4000),
  }));
  return { run_id: id, status: "done", auto_dispatch: true, nodes } as unknown as RunState;
}

describe("auto-dispatch sweep cost", () => {
  test("a second sweep over unchanged runs does not re-parse their state.json", () => {
    const home = TempHome.create();
    try {
      for (let i = 0; i < 25; i++) {
        home.write(`runs/20261123-1000${String(i).padStart(2, "0")}-aaaa/state.json`, JSON.stringify(bigFinishedRun(`20261123-1000${String(i).padStart(2, "0")}-aaaa`)));
      }
      const engine = new RunEngine(home.path, { log: () => {} });
      const first = timed(() => engine.sweep());
      const second = timed(() => engine.sweep());
      // The first sweep parses 25 files of ~250 KB each; the second only stats them.
      expect(second).toBeLessThan(Math.max(first / 3, 20));
    } finally {
      home.dispose();
    }
  });
});

function timed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}
