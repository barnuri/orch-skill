export const USAGE_CATEGORIES = ["tool", "mcp", "skill", "subagent", "agent"] as const;

export type UsageCategory = (typeof USAGE_CATEGORIES)[number];
