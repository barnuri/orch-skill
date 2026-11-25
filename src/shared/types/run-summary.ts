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
  /** Summed node cost in USD, null when no node reported dollars. Optional for older servers. */
  usd?: number | null;
  /** Summed node tokens, null when no node reported tokens. Optional for older servers. */
  tokens?: number | null;
  /** Running nodes with no activity for `settings.stale_minutes`. Omitted when none. */
  stale?: number;
  /** Set on a covered run: the run that took over its unfinished work, with the carried node ids. */
  covered_by?: string;
  covered_note?: string;
  covered_nodes?: string[];
  covered_map?: Record<string, string>;
  /** ISO time of the newest node activity. Omitted when no node has a time. */
  updated?: string;
  /** Why a person finished the run by hand (`run finish --force`). Omitted otherwise. */
  force_finish_reason?: string;
}
