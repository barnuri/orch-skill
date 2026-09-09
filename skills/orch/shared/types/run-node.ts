import type { NodeStatus } from "./node-status";
import type { NodeUsage } from "./node-usage";

export interface RunNode {
  id: string;
  label: string;
  status: NodeStatus;
  profile: string | null;
  adapter: string | null;
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
  usage?: NodeUsage;
}
