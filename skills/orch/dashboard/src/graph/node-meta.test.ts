import { describe, expect, test } from "bun:test";

import type { NodeStatus } from "../../../shared/types/node-status";
import type { RunNode } from "../../../shared/types/run-node";
import { attemptLine, costOf, metaLine } from "./render-graph.ts";

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

describe("metaLine", () => {
  test("pairs status with the catalog model id", () => {
    expect(metaLine(node({ status: "done", profile: "claude-sub", model_id: "claude-sonnet" }))).toBe(
      "done · claude-sonnet",
    );
  });

  test("falls back to the resolved model slug", () => {
    expect(metaLine(node({ status: "done", model: "sonnet" }))).toBe("done · sonnet");
  });

  test("falls back to the adapter when no profile is set", () => {
    expect(metaLine(node({ status: "running", adapter: "cursor-agent" }))).toBe(
      "running · cursor-agent",
    );
  });

  test("status alone when the node has neither", () => {
    expect(metaLine(node({ status: "waiting" }))).toBe("waiting");
  });

  test("a real status/model pair is not truncated", () => {
    expect(metaLine(node({ status: "done", model_id: "claude-opus" }))).toBe("done · claude-opus");
  });

  test("a profile longer than the node is cut, not overflowed", () => {
    const line = metaLine(node({ status: "running", model_id: "a".repeat(80) }));
    expect(line.length).toBeLessThan(40);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("costOf", () => {
  function withCost(usd: number): RunNode {
    return node({
      cost: {
        usd,
        cost_basis: "list",
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        models: [],
      },
    });
  }

  test("formats a normal amount to cents", () => {
    expect(costOf(withCost(0.2409))).toBe("$0.24");
  });

  test("rounds to two decimals above a dollar", () => {
    expect(costOf(withCost(12.3456))).toBe("$12.35");
  });

  test("a sub-cent charge is bounded rather than rounded to free", () => {
    expect(costOf(withCost(0.0016))).toBe("<$0.01");
  });

  test("zero is shown as zero", () => {
    expect(costOf(withCost(0))).toBeNull();
  });

  test("zero-dollar usage falls back to token count", () => {
    const item = withCost(0);
    if (item.cost === undefined || item.cost === null) {
      throw new Error("expected cost");
    }
    item.cost.input_tokens = 1000;
    item.cost.output_tokens = 234;
    expect(costOf(item)).toBe("1,234 tok");
  });

  test("a node whose harness reported no cost has none to show", () => {
    expect(costOf(node())).toBeNull();
    expect(costOf(node({ cost: null }))).toBeNull();
  });

  test("a nonsense amount is not rendered", () => {
    expect(costOf(withCost(Number.NaN))).toBeNull();
    expect(costOf(withCost(-1))).toBeNull();
  });
});

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
