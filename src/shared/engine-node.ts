/**
 * Nodes made by an engine, not by a coordinator: the loop runner adds one tick node `i<N>` per tick to
 * the run `loop-<stamp>-<hex>` it keeps for itself. They end without a handoff.md and are never retried:
 * the loop decides whether another tick runs. Bun-free: the watchdog and the CLI share it.
 */

export const ENGINE_ORIGINS: readonly string[] = ["loop", "watch"];

export interface EngineNodeFields {
  id?: string | null;
  /** Marker `node add --origin loop|watch` writes. */
  origin?: string | null;
  /** The loop that owns the node, when it is not the run's own id. */
  loop_id?: string | null;
}

/** The loop a run belongs to: `loop-…` runs are the loop's own. Null for any other run. */
export function loopOfRun(runId: string): string | null {
  return /^loop-/.test(runId) ? runId : null;
}

/** True for a node the loop or watch engine made: by marker, by `loop_id`, or by tick id in a `loop-`/`watch-` run. */
export function isEngineNode(runId: string, node: EngineNodeFields): boolean {
  if (ENGINE_ORIGINS.includes(node.origin ?? "") || (node.loop_id ?? "") !== "") {
    return true;
  }
  return /^(loop|watch)-/.test(runId) && /^i[0-9]+$/.test(node.id ?? "");
}
