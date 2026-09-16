import { describe, expect, test } from "bun:test";

import type { NodeStatus } from "../../../shared/types/node-status";
import type { RunNode } from "../../../shared/types/run-node";
import { costOf, durationOf, metaLine } from "./render-graph.ts";

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

describe("durationOf", () => {
  test("seconds below a minute", () => {
    expect(
      durationOf(node({ started: "2026-09-15T12:00:00Z", finished: "2026-09-15T12:00:42Z" })),
    ).toBe("42s");
  });

  test("minutes and seconds below an hour", () => {
    expect(
      durationOf(node({ started: "2026-09-15T12:00:00Z", finished: "2026-09-15T12:03:12Z" })),
    ).toBe("3m 12s");
  });

  test("hours and minutes above an hour", () => {
    expect(
      durationOf(node({ started: "2026-09-15T12:00:00Z", finished: "2026-09-15T14:05:00Z" })),
    ).toBe("2h 5m");
  });

  test("a node that never started has no duration to show", () => {
    expect(durationOf(node({ started: null }))).toBeNull();
    expect(durationOf(node({ started: "" }))).toBeNull();
  });

  test("unusable timestamps yield null rather than a dash on the node", () => {
    expect(durationOf(node({ started: "not a date", finished: "also not" }))).toBeNull();
  });

  test("a running node measures against now, so it always has a duration", () => {
    const started = new Date(Date.now() - 90_000).toISOString();
    expect(durationOf(node({ started, finished: null, status: "running" }))).toMatch(/^1m \d+s$/);
  });
});

describe("metaLine", () => {
  test("pairs status with the profile", () => {
    expect(metaLine(node({ status: "done", profile: "claude-sub" }))).toBe("done · claude-sub");
  });

  test("falls back to the adapter when no profile is set", () => {
    expect(metaLine(node({ status: "running", adapter: "cursor-agent" }))).toBe(
      "running · cursor-agent",
    );
  });

  test("status alone when the node has neither", () => {
    expect(metaLine(node({ status: "waiting" }))).toBe("waiting");
  });

  // The pair a real run produced. It shares row 2 with nothing now that the measurements have
  // their own row, so it survives whole — this is what the third row bought.
  test("a real status/profile pair is not truncated", () => {
    expect(metaLine(node({ status: "done", profile: "claude-opus" }))).toBe("done · claude-opus");
  });

  test("a profile longer than the node is cut, not overflowed", () => {
    const line = metaLine(node({ status: "running", profile: "a".repeat(80) }));
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
    expect(costOf(withCost(0))).toBe("$0.00");
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
