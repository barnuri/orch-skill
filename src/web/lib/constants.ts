export const POLL_MS = 2000;
export const FRESH_TICK_MS = 1000;
export const STALE_MS = 15000;
export const DEAD_MS = 60000;
export const TOAST_MS = 4000;
export const TOKEN_KEY = "orch-token";
export const THEME_KEY = "orch-theme";
export const RUN_FILTERS_KEY = "orch-run-filters";
export const PROFILES_HIDE_DISABLED_KEY = "orch-profiles-hide-disabled";
export const GRAPH_FOLLOW_KEY = "orch.graph.follow";
export const GRAPH_HIDE_DONE_KEY = "orch.graph.hideDone";
export const API_BASE = "/api";
// Stacked-bar / meta ordering: the states that need attention come first.
export const STATUS_ORDER = ["running", "error", "done", "skipped", "waiting"] as const;
