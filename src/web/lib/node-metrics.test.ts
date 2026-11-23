import { describe, expect, test } from "bun:test";

import { nodeUsage, runUsage } from "../../shared/run-usage";
import type { RunNode } from "../../shared/types/run-node";
import { fmtTokens } from "./format";
import {
  NOT_STARTED_TEXT,
  NO_ACTUAL_TEXT,
  NO_MODEL_TEXT,
  META_MAX_CHARS,
  actualModelMetric,
  NO_USAGE_TEXT,
  STARTING_TEXT,
  durationMetric,
  statusLine,
  modelMetric,
  cardUsageMetric,
  roleTierMetric,
  effortText,
  effortTitle,
  roleTierText,
  runTotals,
  summaryUsageMetric,
  usageMetric, peakContextMetric,
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

  test("a model from node report is credited to the orchestrator", () => {
    const metric = modelMetric(node({ model: "claude-opus-5-5", report: report({ model: "claude-opus-5-5" }) }));
    expect(metric.title).toContain("orchestrator");
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
    expect(inline.title).toContain("ran inline in the orchestrator session");
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

describe("session_stats fallback", () => {
  const stats = (cost: number, input = 0): NonNullable<RunNode["session_stats"]> => ({
    session: "ses_abc",
    cost,
    tokens: { input, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    created: "2026-11-15T10:00:00Z",
    updated: "2026-11-15T11:30:00Z",
    duration_s: 5400,
    busy: false,
  });

  test("usage reads the bound session when nothing else reported", () => {
    const metric = usageMetric(node({ session_stats: stats(0.98, 1200) }));
    expect(metric.present).toBe(true);
    expect(metric.text).toBe("$0.98");
    expect(metric.title).toContain("ses_abc");
  });
  test("a job cost or a coordinator report wins over the session", () => {
    expect(nodeUsage(node({ cost: cost(2), session_stats: stats(5) })).usd).toBe(2);
    expect(nodeUsage(node({ report: report({ usd: 1 }), session_stats: stats(5) })).source).toBe("report");
  });
  test("a run total counts each node once", () => {
    const total = runUsage([node({ cost: cost(2), session_stats: stats(2) }), node({ id: "n2", session_stats: stats(1) })]);
    expect(total.usd).toBe(3);
    expect(total.reporting).toBe(2);
  });
  test("duration falls back to the session span when the node has no start", () => {
    const metric = durationMetric(node({ status: "done", started: null, session_stats: stats(1) }));
    expect(metric.present).toBe(true);
    expect(metric.text).toBe("1h 30m");
  });
  test("placeholders stay when there is truly nothing", () => {
    expect(usageMetric(node()).text).toBe(NO_USAGE_TEXT);
    expect(durationMetric(node({ status: "waiting" })).text).toBe(NOT_STARTED_TEXT);
  });
});

describe("card rows always drawn", () => {
  test("role, tier and effort show only known values, and nothing when none is known", () => {
    expect(roleTierMetric(node())).toMatchObject({ text: "", present: false });
    expect(roleTierMetric(node({ role: "planning" }))).toMatchObject({ text: "planning", present: true });
    expect(roleTierMetric(node({ tier: "balance" }))).toMatchObject({ text: "balance", present: true });
    expect(roleTierMetric(node({ role: "planning", tier: "balance", effort: "medium" }))).toMatchObject({ text: "medium · planning · balance", present: true });
    expect(roleTierMetric(node({ role: "planning", tier: "balance", effort: "high" })).text).not.toContain("—");
  });

  test("effortText prefers the stored effort and effortTitle lists the history", () => {
    expect(effortText(node({ effort: "high" }))).toBe("high");
    expect(effortTitle(node())).toBeUndefined();
    expect(effortTitle(node({ effort_history: [{ seq: 1, at: 1, effort: "low" }, { seq: 2, at: 2, effort: "high" }] }))).toBe("effort over time: low → high");
  });

  test("usage and cost each have a placeholder", () => {
    expect(cardUsageMetric(node())).toMatchObject({ text: "usage — · cost —", present: false });
    expect(cardUsageMetric(node({ cost: cost(0, 1234) }))).toMatchObject({ text: "1.2k tok · cost —", present: true });
    expect(cardUsageMetric(node({ cost: cost(0.42, 1500) }))).toMatchObject({ text: "1.5k tok · $0.42", present: true });
    expect(cardUsageMetric(node({ report: report({ usd: 0.1 }) })).text).toBe("usage — · $0.10");
  });
});

describe("alias → actual model", () => {
  test("shows alias → actual when the served model differs from the alias", () => {
    const metric = modelMetric(node({ model: "hub/smart-auto-balance", actual_model: "copilot/claude-opus-5-5" }), META_MAX_CHARS);
    expect(metric.text).toBe("smart-a… → claude-opus-5-5");
    expect(metric.text.length).toBeLessThanOrEqual(META_MAX_CHARS);
    expect(metric.title).toContain("copilot/claude-opus-5-5");
  });

  test("shows the alias alone when the actual model matches it or is missing", () => {
    expect(modelMetric(node({ model: "claude-opus-5-5", actual_model: "claude-opus-5-5" })).text).toBe("claude-opus-5-5");
    expect(modelMetric(node({ model: "hub/smart-auto-balance" })).text).toBe("smart-auto-balance");
  });

  test("actualModelMetric shows the placeholder when no actual model is known", () => {
    const missing = actualModelMetric(node());
    expect(missing.text).toBe(NO_ACTUAL_TEXT);
    expect(missing.present).toBe(false);
    expect(actualModelMetric(node({ actual_model: "copilot/gpt-x" })).text).toBe("copilot/gpt-x");
  });
});

describe("real run time", () => {
  const T0 = Date.parse("2026-11-15T10:00:00Z");
  const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

  test("a starting node shows the starting text with its wait, ticking from dispatch", () => {
    const n = node({ status: "running", dispatched_at: at(0), started_at: null, seg_open: true });
    const metric = durationMetric(n, null, T0 + 12_000);
    expect(metric.text).toBe(`${STARTING_TEXT} · waited 12s`);
    expect(metric.present).toBe(false);
    expect(metric.liveSince).toBe(at(0));
    expect(statusLine(n, 3)).toStartWith(STARTING_TEXT);
  });
  test("the status row shows progress while running and the retry time after an error", () => {
    expect(statusLine(node({ status: "running", progress: "3/10" }), 5)).toBe("running 3/10 · attempt 1/5");
    expect(statusLine(node({ status: "done", progress: "3/10" }), 5)).toBe("done · attempt 1/5");
    const retryAt = new Date(2026, 10, 17, 14, 2).toISOString();
    expect(statusLine(node({ status: "error", next_retry_at: retryAt, attempts: [{ job_id: null, error: "x", finished: null, log_tail: [], profile: null }] }), 5)).toBe("error 2/5 · retry 14:02");
  });
  test("a timed node shows run time and queue time", () => {
    const n = node({ status: "done", dispatched_at: at(0), started_at: at(5), finished_at: at(65), seg_open: false, run_segments: [{ dispatched: at(0), start: at(5), end: at(65) }] });
    const metric = durationMetric(n, null, T0 + 100_000);
    expect(metric.text).toBe("1m 0s · waited 5s");
    expect(metric.present).toBe(true);
    expect(metric.liveSince).toBeNull();
  });
  test("run pauses are left out of a node's run time", () => {
    const n = node({ status: "running", dispatched_at: at(0), started_at: at(0), seg_open: true });
    const metric = durationMetric(n, { pauses: [{ from: at(10), to: at(40) }] }, T0 + 60_000);
    expect(metric.text).toBe("30s");
    expect(metric.liveSince).toBe(at(0));
  });
  test("runTotals leaves pauses out", () => {
    const totals = runTotals({ started: at(0), finished: at(120), nodes: [node()], pauses: [{ from: at(30), to: at(90) }] });
    expect(totals.duration.text).toBe("1m 0s");
    expect(totals.duration.title).toContain("1m 0s paused or stopped, left out");
  });
});

describe("peakContextMetric", () => {
  const withPeak = (peak?: number) =>
    node({ session_stats: { session: "ses_abc", cost: 1, tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }, created: "", updated: "", duration_s: 1, busy: false, ...(peak === undefined ? {} : { peak_context: peak, steps: 4, avg_context: 90000 }) } });

  test("no peak, no chip", () => {
    expect(peakContextMetric(withPeak())).toBeNull();
    expect(peakContextMetric(node())).toBeNull();
  });
  test("warns only above 200k", () => {
    expect(peakContextMetric(withPeak(200000))).toMatchObject({ text: "ctx 200k", over: false });
    const over = peakContextMetric(withPeak(250000));
    expect(over).toMatchObject({ text: "ctx 250k", over: true });
    expect(over?.title).toContain("4 steps");
  });
});
