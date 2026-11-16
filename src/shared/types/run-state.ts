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
}
