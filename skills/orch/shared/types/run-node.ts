import type { NodeStatus } from "./node-status";
import type { NodeUsage } from "./node-usage";

export interface RunNode {
  id: string;
  label: string;
  status: NodeStatus;
  profile: string | null;
  adapter: string | null;
  job_id: string | null;
  started: string | null;
  finished: string | null;
  error: string | null;
  log_tail: string[];
  usage?: NodeUsage;
}
