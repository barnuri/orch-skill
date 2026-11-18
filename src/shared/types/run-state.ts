import type { TimingPause } from "../node-timing";
import type { RunNode } from "./run-node";
import type { RunPlan } from "./run-plan";
import type { RunStatus } from "./run-status";

export interface RunState {
  run_id: string;
  title: string;
  harness_session: string;
  started: string;
  finished: string | null;
  status: RunStatus;
  nodes: RunNode[];
  edges: [string, string][];
  /** Present on runs started through `orch plan`; absent on hand-built runs. */
  plan?: RunPlan | null;
  /** Set by `dispatch.ts run stop`: never auto-resumes; the run page Resume button resumes it. */
  stopped?: boolean;
  /** Set by `run finish --force --reason`: why the verify gate was bypassed. */
  force_finish_reason?: string | null;
  /** Set by `dispatch.ts run pause`: starts no node until `run resume`. */
  paused?: boolean;
  /** Added by GET /api/runs/<id>: the coordinator's reachability and pending asks. */
  coordinator_state?: import("./coordinator").CoordinatorState | null;
  /** Set by `run cover`: the run whose nodes took over this run's unfinished work. */
  covered_by?: string | null;
  covered_at?: string | null;
  covered_note?: string | null;
  /** Ids of this run's not-done nodes at cover time. */
  covered_nodes?: string[] | null;
  /** oldNode -> newNode pairs. */
  covered_map?: Record<string, string> | null;
  paused_at?: string | null;
  stopped_at?: string | null;
  /** Closed paused or stopped stretches, written by `run resume`; node durations leave them out. */
  pauses?: TimingPause[] | null;
}
