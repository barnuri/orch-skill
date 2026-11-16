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
  /** Set by `dispatch.sh run stop`: never auto-resumes; the run page Resume button resumes it. */
  stopped?: boolean;
  /** Set by `dispatch.sh run pause`: starts no node until `run resume`. */
  paused?: boolean;
  paused_at?: string | null;
  stopped_at?: string | null;
  /** Closed paused or stopped stretches, written by `run resume`; node durations leave them out. */
  pauses?: TimingPause[] | null;
}
