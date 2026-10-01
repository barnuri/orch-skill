import type { NodeCost } from "./node-cost";
import type { NodeStatus } from "./node-status";
import type { NodeUsage } from "./node-usage";

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
}
