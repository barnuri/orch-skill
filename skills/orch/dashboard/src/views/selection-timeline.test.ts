import { describe, expect, test } from "bun:test";

import type { RunNode } from "../../../shared/types/run-node";
import type { SelectionEvent } from "../../../shared/types/selection-event";
import {
  TIMELINE_VISIBLE_EVENTS,
  activeStageSummary,
  formatSelectionLine,
  timelineEvents,
} from "./selection-timeline";

function event(overrides: Partial<SelectionEvent>): SelectionEvent {
  return {
    seq: 1,
    ts: "2026-11-01T10:00:00Z",
    workflow_key: null,
    worker_key: null,
    attempt_key: null,
    turn_key: null,
    requested_selector: "hub/smart-auto-balance",
    tier: "balance",
    role: "implementation",
    stage: "solver",
    model: "llama_swap/qwen3.6-35b",
    state: "selected",
    reason_code: null,
    policy_version: null,
    requested_effort: null,
    selected_effort: null,
    sent_effort: null,
    confirmed_effort: null,
    latency_ms: null,
    usage: null,
    ...overrides,
  };
}

function node(overrides: Partial<RunNode>): RunNode {
  return {
    id: "n1",
    label: "Node",
    status: "running",
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

describe("formatSelectionLine", () => {
  test("names the stage, state, model and reason of a selection", () => {
    expect(formatSelectionLine(event({ seq: 7, reason_code: "role_fit" }))).toBe(
      "#7 · solver · selected · llama_swap/qwen3.6-35b · role_fit",
    );
  });

  test("prefers the sent effort and adds latency when the hub reports it", () => {
    const line = formatSelectionLine(
      event({ seq: 8, state: "completed", selected_effort: "low", sent_effort: "medium", latency_ms: 820 }),
    );
    expect(line).toBe("#8 · solver · completed · llama_swap/qwen3.6-35b · effort medium · 820 ms");
  });

  test("marks a selection with no model rather than hiding the line", () => {
    expect(formatSelectionLine(event({ seq: 2, model: null, state: "rejected" }))).toBe(
      "#2 · solver · rejected · no model",
    );
  });

  test("uses the selected effort when no effort was sent", () => {
    expect(formatSelectionLine(event({ seq: 3, selected_effort: "high" }))).toBe(
      "#3 · solver · selected · llama_swap/qwen3.6-35b · effort high",
    );
  });
});

describe("activeStageSummary", () => {
  test("reports plain selection while only the solver is active", () => {
    expect(activeStageSummary(node({ active_stages: ["solver"] }))).toBe("selecting");
  });

  test("lists the reviewing stages once a judge or critic is active", () => {
    expect(activeStageSummary(node({ active_stages: ["solver", "judge", "critic"] }))).toBe(
      "reviewing: judge, critic",
    );
  });

  test("is null when no stage is active", () => {
    expect(activeStageSummary(node({ active_stages: [] }))).toBeNull();
    expect(activeStageSummary(node({}))).toBeNull();
  });
});

describe("timelineEvents", () => {
  test("orders the newest sequence first without changing the stored order", () => {
    const stored = [event({ seq: 1 }), event({ seq: 3 }), event({ seq: 2 })];
    expect(timelineEvents(stored).map((item) => item.seq)).toEqual([3, 2, 1]);
    expect(stored.map((item) => item.seq)).toEqual([1, 3, 2]);
  });

  test("keeps only the visible limit", () => {
    const many = Array.from({ length: TIMELINE_VISIBLE_EVENTS + 5 }, (_, index) => event({ seq: index + 1 }));
    const shown = timelineEvents(many);
    expect(shown).toHaveLength(TIMELINE_VISIBLE_EVENTS);
    expect(shown[0]?.seq).toBe(TIMELINE_VISIBLE_EVENTS + 5);
  });
});
