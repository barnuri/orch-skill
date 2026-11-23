export const NODE_STATUSES = ["waiting", "running", "done", "error", "skipped", "stopped", "covered", "blocked-user"] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];
