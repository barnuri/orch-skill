import type { NodeModelCost } from "./node-model-cost";

/**
 * What one node's dispatch cost, as reported by its harness rather than priced by orch.
 *
 * Only the claude adapter reports this, and only through `start` — `run` has no job directory to
 * carry the harness's usage back in. A node with no `cost` is the normal case, not an error.
 */
export interface NodeCost {
  /** `total_cost_usd` from the harness. */
  usd: number;
  /**
   * The harness's `costBasis`, in practice `"list"` — list price, which is **not** what a
   * subscription is billed. Carried so the UI can say which it is showing.
   */
  cost_basis: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Per-model split; a single dispatch can touch more than one model. */
  models: NodeModelCost[];
}
