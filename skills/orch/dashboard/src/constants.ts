export const POLL_MS = 2000;
export const FRESH_TICK_MS = 1000;
export const STALE_MS = 15000;
export const DEAD_MS = 60000;
export const TOAST_MS = 4000;
export const TOKEN_KEY = "orch-token";
export const THEME_KEY = "orch-theme";
export const API_BASE = "/api";
// Stacked-bar / meta ordering: the states that need attention come first.
export const STATUS_ORDER = ["running", "error", "done", "skipped", "waiting"] as const;
