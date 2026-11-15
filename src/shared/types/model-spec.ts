import type { ComplexityTier, CostTier, QualityTier, SpeedTier } from "./routing-enums";

export interface ModelSpec {
  slug: string;
  harnesses: string[];
  /**
   * Which model in the harness's own catalog this one should be treated as, when it is reached
   * through a gateway. Claude Code refuses a `--model` it does not recognise, so a hub id like
   * `llama_swap/lfm2.5-8b-a1b` only runs once it is mapped onto a model the CLI knows.
   */
  behaves_as?: string;
  description?: string;
  cost?: CostTier;
  quality?: QualityTier;
  speed?: SpeedTier;
  max_complexity?: ComplexityTier;
  tags?: string[];
}
