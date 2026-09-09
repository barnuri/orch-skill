import type { ComplexityTier, CostTier, QualityTier, SpeedTier } from "./routing-enums";

export interface ModelSpec {
  slug: string;
  harnesses: string[];
  description?: string;
  cost?: CostTier;
  quality?: QualityTier;
  speed?: SpeedTier;
  max_complexity?: ComplexityTier;
  tags?: string[];
}
