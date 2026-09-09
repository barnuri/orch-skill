export const RUN_STATUSES = ["running", "done", "error"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
