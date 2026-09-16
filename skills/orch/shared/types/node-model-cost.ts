/** One model's slice of a node's cost, as the harness reported it. */
export interface NodeModelCost {
  /** The harness's own model id, e.g. `claude-opus-5[1m]`. */
  model: string;
  usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}
