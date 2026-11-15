import type { NodeCost } from "./node-cost";
import type { NodeStatus } from "./node-status";
import type { NodeUsage } from "./node-usage";
import type { SelectionEvent, SelectionStage } from "./selection-event";

export const WORK_ROLE_VALUES = ["planning", "investigation", "implementation", "validation", "conversation"] as const;
export type WorkRole = (typeof WORK_ROLE_VALUES)[number];

export const SMART_AUTO_TIER_VALUES = ["efficiency", "balance", "intelligence", "fast"] as const;
export type SmartAutoTier = (typeof SMART_AUTO_TIER_VALUES)[number];

export interface RunNodeAttempt {
  job_id: string | null;
  error: string | null;
  finished: string | null;
  log_tail: string[];
  profile: string | null;
  adapter?: string | null;
  model?: string | null;
  model_id?: string | null;
  cost?: NodeCost | null;
  session?: string | null;
  reason?: string | null;
  retry_mode?: "resumed" | "restarted" | null;
  retry_session?: string | null;
}

export interface RunNode {
  id: string;
  label: string;
  status: NodeStatus;
  profile: string | null;
  adapter: string | null;
  model?: string | null;
  model_id?: string | null;
  job_id: string | null;
  /**
   * The harness session id orch assigned at dispatch, so the node can be resumed. Optional
   * because the reader casts state.json straight through: a run written before this field
   * existed has no `session` key at all.
   */
  session?: string | null;
  started: string | null;
  finished: string | null;
  error: string | null;
  log_tail: string[];
  /** Prompt reference or inline text passed to the last dispatch. Optional for older runs. */
  prompt?: string | null;
  /** Arguments that followed the prompt on the last dispatch. Optional for older runs. */
  dispatch_args?: string[];
  /** Failed/skipped attempts archived before retries. Optional for older runs. */
  attempts?: RunNodeAttempt[];
  /** Earliest automatic retry time for an errored node. Optional for older runs. */
  next_retry_at?: string | null;
  usage?: NodeUsage;
  /**
   * What the dispatch cost, when the harness reported it. Optional and nullable: most adapters
   * report nothing, and a run written before this field existed has no `cost` key at all.
   */
  cost?: NodeCost | null;
  /** The work role the node was added with. Optional and nullable for older runs. */
  role?: WorkRole | null;
  /** The Smart Auto tier the node was added with. Optional and nullable for older runs. */
  tier?: SmartAutoTier | null;
  /** Whether a plan reference, expected files and acceptance checks back the node. */
  plan_backed?: boolean;
  /** Acceptance checks the node must meet, as free text. Optional for older runs. */
  acceptance?: string | null;
  /** The worker identity sent to the hub as run/node/attempt, or null when none was sent. */
  worker_identity?: string | null;
  /** How the worker identity travels: request headers, or only the preset model id. */
  metadata_transport?: "headers" | "preset-model" | null;
  /** The selector the node asked for, from the latest hub event. Optional for older runs. */
  requested_selector?: string | null;
  /** The model that served the latest solver stage. Optional for older runs. */
  main_model?: string | null;
  /** Stages with no completion yet, from the latest hub events. Optional for older runs. */
  active_stages?: SelectionStage[];
  /** The highest hub sequence already stored for this node. Optional for older runs. */
  last_event_sequence?: number | null;
  /** Hub selection events for this node, ordered by sequence and bounded. Optional for older runs. */
  selection_history?: SelectionEvent[];
  /** Who is doing the work: an agent id, a job id or "coordinator". Null/absent = unowned. */
  owner?: string | null;
  /** Parsed from `owner`: session | process | job | none | unknown. */
  owner_kind?: string | null;
  owner_id?: string | null;
  /** From owner verification: alive | finished | gone | unknown. */
  owner_state?: "alive" | "finished" | "gone" | "unknown" | "unbound" | null;
  /** Why the owner is unbound or the node unowned, from the owner binder. */
  owner_reason?: string | null;
  /** How the owner session was found: literal | title | time | listing-*. */
  owner_bind?: string | null;
  /** Set by the binder: running a while with no owner at all. */
  unowned?: boolean | null;
  owner_checked?: string | null;
  /** The owner said it finished; nobody reviewed the result yet. */
  unverified?: boolean | null;
  /** When the node was added. Optional for older runs. */
  created?: string | null;
  /** Last heartbeat: any status change, ping, report or usage write. Optional for older runs. */
  updated?: string | null;
  /** Free-text notes from `node ping` / `node report`, newest last, at most 20. */
  notes?: NodeNote[];
  /** Progress text from `node ping --progress`, e.g. "3/10". */
  progress?: string | null;
  /** True when the node was finished without ever being recorded as running. */
  backfilled?: boolean;
  /** Computed by the server for a running node: ISO time of its newest sign of life. */
  last_activity?: string | null;
  /** Computed by the server: running with no activity for settings.stale_minutes. */
  stale?: boolean;
  /** Model and usage the coordinator reported with `node report`. Optional for older runs. */
  report?: NodeReport | null;
  /** llm-hub native mode: the model the hub expected before dispatch and the one it used. */
  hub?: NodeHubPick | null;
}

export interface NodeNote {
  at: string;
  text: string;
}

/** What `node report` recorded for work done inline or by a subagent. Null fields were not reported. */
export interface NodeReport {
  reported_by: "inline";
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  usd: number | null;
  note: string | null;
  at: string;
}

/** One hub pick: the qualified model id plus the tier, role and reason the hub reported. */
export interface HubPick {
  model: string;
  tier?: string | null;
  role?: string | null;
  reason?: string | null;
}

/** What llm-hub expected for a node, what it used, and the outcome orch reported back. */
export interface NodeHubPick {
  expected: HubPick | null;
  actual: HubPick | null;
  outcome: "tests_passed" | "tests_failed" | null;
}
