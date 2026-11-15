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
  herdr?: boolean;
}
