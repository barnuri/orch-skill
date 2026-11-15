/** One node's verdict from `dispatch.sh run health <id> --json`. */
/** `needs-user`: a waiting node blocked on the user (`node update --needs-user`); never ready, never nudged. */
export type NodeHealthState = "ok" | "stalled" | "unowned" | "dead" | "no-report" | "needs-user";

export interface NodeHealth {
  id: string;
  status: string;
  health: NodeHealthState;
  owner_id: string | null;
  last_activity: string | null;
  idle_min: number | null;
  note: string | null;
}

/** The whole JSON `run health <id> --json` prints. */
export interface RunHealth {
  run: string;
  at: string;
  max_parallel: number;
  running: number;
  slots: number;
  nodes: NodeHealth[];
  ready: string[];
  changes: unknown[];
}

/** Where the latest result came from: the server's own pass, the run's `health:<id>` monitor, or nothing yet. */
export type RunHealthSource = "watcher" | "monitor" | "none";

export interface RunHealthEnvelope {
  generated_at: string;
  source: RunHealthSource;
  health: RunHealth | null;
}

/** `GET /api/health/summary`: node-health counts over the running runs, from the watcher's memory only. */
export interface HealthSummary {
  generated_at: string;
  running_runs: number;
  stalled: number;
  dead: number;
  unowned: number;
  no_report: number;
  /** Waiting nodes blocked on the user; not counted as needing attention from the coordinator. */
  needs_user: number;
  ready: number;
  /** Running runs with at least one node that is not ok. */
  flagged_runs: string[];
}
