/** How many attempts a node used. A node read straight from state.json carries `attempt_count`; a hydrated one carries `attempts`. */
export function attemptCount(node: { attempts?: unknown[] | null; attempt_count?: number | null } | null | undefined): number {
  if (!node) return 0;
  return Array.isArray(node.attempts) ? node.attempts.length : Number(node.attempt_count ?? 0) || 0;
}
