import { describe, expect, test } from "bun:test";

import { nodeUsage, runUsage } from "../../../shared/run-usage";
import type { RunNode } from "../../../shared/types/run-node";
import { fmtTokens } from "../dom/format.ts";
import {
  NOT_STARTED_TEXT,
  NO_MODEL_TEXT,
  NO_USAGE_TEXT,
  durationMetric,
  modelMetric,
  roleTierText,
  runTotals,
  summaryUsageMetric,
  usageMetric,
} from "./node-metrics.ts";

function node(overrides: Partial<RunNode> = {}): RunNode {
  return {
    id: "n1",
    label: "first",
    status: "done",
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

const cost = (usd: number, input = 0): NonNullable<RunNode["cost"]> => ({
  usd,
  cost_basis: "list",
  input_tokens: input,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  models: [],
});

const report = (overrides: Partial<NonNullable<RunNode["report"]>> = {}): NonNullable<RunNode["report"]> => ({
  reported_by: "inline",
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  usd: null,
  note: null,
  at: "2026-11-15T10:00:00Z",
  ...overrides,
});

describe("modelMetric", () => {
  test("says so when no model was recorded", () => {
    const metric = modelMetric(node());
    expect(metric.text).toBe(NO_MODEL_TEXT);
    expect(metric.present).toBe(false);
    expect(metric.title).toContain("node report --model");
  });

  test("the hub's actual model beats the expected one and the profile model", () => {
    const metric = modelMetric(
      node({
        model: "hub-smart-auto-balance",
        hub: { expected: { model: "p/haiku" }, actual: { model: "p/claude-opus-5-5" }, outcome: null },
      }),
    );
    expect(metric.text).toBe("claude-opus-5-5");
    expect(metric.present).toBe(true);
  });

  test("an expected-only pick is marked and the profile model is the last resort", () => {
    expect(modelMetric(node({ hub: { expected: { model: "p/haiku" }, actual: null, outcome: null } })).text).toBe("~haiku");
    expect(modelMetric(node({ model: "sonnet" })).text).toBe("sonnet");
  });

  test("a model from node report is credited to the coordinator", () => {
    const metric = modelMetric(node({ model: "claude-opus-5-5", report: report({ model: "claude-opus-5-5" }) }));
    expect(metric.title).toContain("coordinator");
  });
});

describe("usageMetric", () => {
  test("dollars win and tokens go in the tooltip", () => {
    const metric = usageMetric(node({ cost: cost(0.42, 1500) }));
    expect(metric.text).toBe("$0.42");
    expect(metric.title).toContain("1.5k tok");
  });

  test("tokens show when no dollars were reported", () => {
    expect(usageMetric(node({ cost: cost(0, 1234) })).text).toBe("1.2k tok");
  });

  test("a node report counts, and its zero dollars are real", () => {
    expect(usageMetric(node({ report: report({ usd: 0.1 }) })).text).toBe("$0.10");
    expect(usageMetric(node({ report: report({ input_tokens: 900, output_tokens: 100 }) })).text).toBe("1.0k tok");
    expect(usageMetric(node({ report: report({ usd: 0 }) })).text).toBe("$0.00");
  });

  test("nothing reported is a placeholder that explains why", () => {
    const inline = usageMetric(node());
    expect(inline.text).toBe(NO_USAGE_TEXT);
    expect(inline.present).toBe(false);
    expect(inline.title).toContain("ran inline in the coordinator session");
    expect(usageMetric(node({ job_id: "j1", cost: cost(0) })).title).toContain("job j1");
  });
});

describe("durationMetric", () => {
  test("a waiting node has not started", () => {
    const metric = durationMetric(node({ status: "waiting" }));
    expect(metric.text).toBe(NOT_STARTED_TEXT);
    expect(metric.liveSince).toBeNull();
  });

  test("a running node ticks from its start", () => {
    const metric = durationMetric(node({ status: "running", started: "2026-11-15T10:00:00Z" }));
    expect(metric.liveSince).toBe("2026-11-15T10:00:00Z");
    expect(metric.present).toBe(true);
  });

  test("a finished node shows the span between its stamps", () => {
    const metric = durationMetric(node({ started: "2026-11-15T10:00:00Z", finished: "2026-11-15T10:01:05Z" }));
    expect(metric.text).toBe("1m 5s");
    expect(metric.liveSince).toBeNull();
    expect(metric.title).toContain("inline");
  });

  test("a finished node with no start says the duration is unknown", () => {
    const metric = durationMetric(node({ finished: "2026-11-15T10:01:05Z" }));
    expect(metric.text).toBe("duration unknown");
    expect(metric.present).toBe(false);
  });
});

describe("roleTierText", () => {
  test("joins what is set and is null otherwise", () => {
    expect(roleTierText(node())).toBeNull();
    expect(roleTierText(node({ role: "validation" }))).toBe("validation");
    expect(roleTierText(node({ role: "planning", tier: "balance" }))).toBe("planning · balance");
  });
});

describe("usage totals", () => {
  test("nodeUsage prefers the harness cost over the report", () => {
    expect(nodeUsage(node({ cost: cost(0.5), report: report({ usd: 9 }) })).usd).toBe(0.5);
    expect(nodeUsage(node()).source).toBeNull();
  });

  test("runUsage sums what was reported and counts the nodes that reported", () => {
    const usage = runUsage([node({ cost: cost(0.5) }), node({ report: report({ usd: 0.25, input_tokens: 10 }) }), node()]);
    expect(usage.usd).toBe(0.75);
    expect(usage.tokens).toBe(10);
    expect(usage.reporting).toBe(2);
    expect(usage.total).toBe(3);
  });

  test("runTotals gives duration, usage and done/total", () => {
    const totals = runTotals({
      started: "2026-11-15T10:00:00Z",
      finished: "2026-11-15T10:02:00Z",
      nodes: [node({ cost: cost(1) }), node({ status: "waiting" })],
    });
    expect(totals.duration.text).toBe("2m 0s");
    expect(totals.duration.liveSince).toBeNull();
    expect(totals.usage.text).toBe("$1.00");
    expect(totals.usage.title).toContain("1 of 2");
    expect([totals.done, totals.total]).toEqual([1, 2]);
  });

  test("a run with nothing reported shows the placeholder", () => {
    expect(runTotals({ started: "2026-11-15T10:00:00Z", finished: null, nodes: [node()] }).usage.text).toBe(NO_USAGE_TEXT);
    expect(summaryUsageMetric({}).text).toBe(NO_USAGE_TEXT);
    expect(summaryUsageMetric({ usd: 2.5 }).text).toBe("$2.50");
    expect(summaryUsageMetric({ tokens: 2_500_000 }).text).toBe("2.5M tok");
  });
});

describe("fmtTokens", () => {
  test("scales with k and M and rejects nonsense", () => {
    expect(fmtTokens(950)).toBe("950 tok");
    expect(fmtTokens(12_400)).toBe("12.4k tok");
    expect(fmtTokens(-1)).toBe("—");
  });
});
