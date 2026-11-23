/** One node's verdict from `dispatch.ts run health <id> --json`. */
/** `needs-user`: a waiting node blocked on the user (`node update --needs-user`); never ready, never nudged.
 *  `held`: a waiting node the coordinator holds back (`node update --hold`); never ready, never flagged. */
export type NodeHealthState = "ok" | "stalled" | "unowned" | "dead" | "no-report" | "needs-user" | "held";

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
  slots: number | null;
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
  cache?: import("./runs-envelope").ApiCacheInfo;
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
  /** The orch herdr instance's latest check; null before the first one. */
  herdr?: HerdrHealth | null;
}

/** State of the orch herdr instance: `ok`, `degraded` (up, not registered or not listed in herdr web), `down`, `off` (disabled). */
export type HerdrHealthState = "ok" | "degraded" | "down" | "off";

/** `dispatch.ts herdr health --json`: the orch skill's own herdr instance and its herdr web env. */
export interface HerdrHealth {
  state: HerdrHealthState;
  enabled: boolean;
  reason: string;
  env_id: string;
  pid: number | null;
  pid_alive: boolean;
  socket_ok: boolean;
  /** The herdr web registry file: `ok`, `missing` or `wrong`. */
  registry: string;
  registry_path: string;
  /** What the herdr web plugin says: `listed`, `unreachable`, `missing`, `no-plugin` or `skipped`. */
  web: string;
  web_url: string;
  nudged: boolean;
  at: string;
  problems: string[];
}
