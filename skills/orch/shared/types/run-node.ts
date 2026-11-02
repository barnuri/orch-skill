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
}
