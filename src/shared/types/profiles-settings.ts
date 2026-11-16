import type { LearningSettings } from "./learning-settings";

export interface ProfilesSettings {
  default_profile?: string;
  retention_days?: number;
  budget_threshold?: number;
  /** Most nodes of one run that `run advance` keeps running at once. */
  max_parallel?: number;
  /** Total tries per node before dependents stay blocked; 1 disables, -1 is unlimited. */
  max_attempts?: number;
  /** Minutes without activity before a running node is marked stale. Default 10. */
  stale_minutes?: number;
  /** Seconds between the server's node-health sweeps (ORCH_HEALTH_EVERY_SEC wins). Default 30. */
  health_every_sec?: number;
  /** Most task nodes `plan apply` accepts from one plan. */
  max_nodes?: number;
  /** Profile `orch plan` dispatches the planner node on. */
  planner_profile?: string;
  learning?: LearningSettings;
  /** Harness ids hidden from profile pickers (adapters remain in code). */
  disabled_harnesses?: string[];
  /** Runs each started job in a pane of the main Herdr session's "orch" workspace. */
  /** Per harness: where its profiles may be used. Missing means both. */
  harness_usage?: Record<string, Array<"chat" | "runs">>;
  herdr?: boolean;
  /** Folders a chat may run in (absolute, or `~/…`). Default `["~/sandbox/private"]`. */
  chat_roots?: string[];
  /** Hours a missed chat schedule may still run late. Default 6; 0 to 72. */
  schedule_grace_hours?: number;
  /** Chat monitors may check link-local addresses (cloud metadata). Default off. */
  monitor_allow_link_local?: boolean;
}
