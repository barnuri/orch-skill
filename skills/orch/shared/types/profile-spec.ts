import type { ComplexityTier, CostTier, QualityTier, RiskTier, SpeedTier } from "./routing-enums";

export interface ProfileSpec {
  harness: string;
  model?: string;
  allowed_models?: string[];
  description?: string;
  cost?: CostTier;
  quality?: QualityTier;
  speed?: SpeedTier;
  risk?: RiskTier;
  enabled?: boolean;
  tags?: string[];
  strengths?: string[];
  avoid_for?: string[];
  min_complexity?: ComplexityTier;
  max_complexity?: ComplexityTier;
  parallel_ok?: boolean;
  priority?: number;
  fallback?: string;
  example_tasks?: string[];
  flags?: string[];
  env?: Record<string, string>;
  auth?: string[];
}
