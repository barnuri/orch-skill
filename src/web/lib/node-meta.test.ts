import { describe, expect, test } from "bun:test";

import type { NodeStatus } from "../../shared/types/node-status";
import type { RunNode } from "../../shared/types/run-node";
import { attemptLine, statusLine } from "./node-metrics";

function node(overrides: Partial<RunNode> = {}): RunNode {
  return {
    id: "n1",
    label: "first",
    status: "done" as NodeStatus,
    profile: null,
    adapter: null,
    job_id: null,
    started: null,
    finished: null,
    error: null,
    log_tail: [],
    ...overrides,
  };
}

describe("attemptLine", () => {
  test("starts at attempt one", () => {
    expect(attemptLine(node(), 5)).toBe("attempt 1/5");
  });

  test("counts archived attempts plus the current try", () => {
    expect(attemptLine(node({ attempts: [{ job_id: "a", error: null, finished: null, log_tail: [], profile: null }] }), 5)).toBe(
      "attempt 2/5",
    );
  });

  test("uses infinity for unlimited automatic attempts", () => {
    expect(attemptLine(node({ attempts: [{ job_id: "a", error: null, finished: null, log_tail: [], profile: null }] }), -1)).toBe(
      "attempt 2/∞",
    );
  });

  test("labels manual retries beyond the automatic cap", () => {
    expect(attemptLine(node({ attempts: new Array(5).fill({ job_id: null, error: null, finished: null, log_tail: [], profile: null }) }), 5)).toBe(
      "manual retry 6",
    );
  });
});

describe("statusLine", () => {
  test("pairs the status with the attempt", () => {
    expect(statusLine(node({ status: "done" }), 5)).toBe("done · attempt 1/5");
  });

  test("fits the node width", () => {
    expect(statusLine(node({ status: "running", attempts: new Array(5).fill({ job_id: null, error: null, finished: null, log_tail: [], profile: null }) }), 5).length).toBeLessThanOrEqual(26);
  });
});
