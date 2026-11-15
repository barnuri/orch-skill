export const RUN_STATUSES = ["running", "done", "error", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
