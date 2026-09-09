import type { UsageCategory } from "./usage-category";

/**
 * Per-node call counts, `{category: {name: count}}`. A category is absent until the node
 * records something under it, so an untouched node carries `{}` rather than five empty maps.
 */
export type NodeUsage = Partial<Record<UsageCategory, Record<string, number>>>;
