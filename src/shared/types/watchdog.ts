/** Which watchdog rule took an action. */
export type WatchdogRule = "lost" | "stalled" | "unverified" | "infra-retry" | "finish";

/** One line of `<home>/watchdog/actions.log`. */
export interface WatchdogAction {
  at: string;
  run: string;
  node: string | null;
  rule: WatchdogRule;
  /** What the watchdog did: a dispatch.sh call, or `flag` when it only reports. */
  action: string;
  detail: string;
  /** dispatch.sh exit code; null for a report-only action. */
  rc: number | null;
}

/** Per-run action counts. */
export interface WatchdogCounters {
  lost: number;
  stalled: number;
  unverified: number;
  retried: number;
  flagged: number;
  finished: number;
}

/** A node the watchdog reports and does not act on (stalled, or out of retries). */
export interface WatchdogFlag {
  run: string;
  node: string;
  rule: WatchdogRule;
  detail: string;
  at: string;
}

export interface WatchdogStatus {
  generated_at: string;
  /** `on`: the server's watchdog runs; `off`: it was not started (only the log is read). */
  state: "on" | "off";
  started_at: string | null;
  last_actions: WatchdogAction[];
  runs: Record<string, WatchdogCounters>;
  flags: WatchdogFlag[];
}
