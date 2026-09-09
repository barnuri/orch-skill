import type { NodeStatus } from "./node-status";
import type { RunStatus } from "./run-status";

export interface RunSummary {
  run_id: string;
  title: string;
  status: RunStatus;
  started: string;
  finished: string | null;
  harness_session: string;
  counts: Record<NodeStatus, number>;
}
