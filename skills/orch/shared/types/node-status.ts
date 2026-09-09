export const NODE_STATUSES = ["waiting", "running", "done", "error", "skipped"] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];
