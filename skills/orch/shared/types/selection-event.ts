export const SELECTION_STAGE_VALUES = ["solver", "judge", "critic", "repair"] as const;
export type SelectionStage = (typeof SELECTION_STAGE_VALUES)[number];

export const SELECTION_STATE_VALUES = ["selected", "started", "completed", "rejected", "cancelled"] as const;
export type SelectionState = (typeof SELECTION_STATE_VALUES)[number];

/**
 * One model selection the hub reported for a worker. Scope keys are salted hashes, so the
 * event carries no prompt text; `seq` is the hub's monotonic sequence and orders the history.
 */
export interface SelectionEvent {
  seq: number;
  ts: string;
  workflow_key: string | null;
  worker_key: string | null;
  attempt_key: string | null;
  turn_key: string | null;
  requested_selector: string | null;
  tier: string | null;
  role: string | null;
  stage: SelectionStage;
  model: string | null;
  state: SelectionState;
  reason_code: string | null;
  policy_version: number | null;
  requested_effort: string | null;
  selected_effort: string | null;
  sent_effort: string | null;
  confirmed_effort: string | null;
  latency_ms: number | null;
  usage: SelectionUsage | null;
}

/** Token usage for one selection. Cache fields are absent when the upstream did not report them. */
export interface SelectionUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
}
