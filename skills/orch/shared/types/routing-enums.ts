export const COST_VALUES = ["free", "subscription", "low", "metered", "high"] as const;
export type CostTier = (typeof COST_VALUES)[number];

export const QUALITY_VALUES = ["draft", "standard", "best"] as const;
export type QualityTier = (typeof QUALITY_VALUES)[number];

export const SPEED_VALUES = ["fast", "balanced", "slow"] as const;
export type SpeedTier = (typeof SPEED_VALUES)[number];

export const RISK_VALUES = ["low", "medium", "high"] as const;
export type RiskTier = (typeof RISK_VALUES)[number];

export const COMPLEXITY_VALUES = ["trivial", "small", "medium", "large"] as const;
export type ComplexityTier = (typeof COMPLEXITY_VALUES)[number];

export const SUGGESTION_STATUSES = ["pending", "applied", "dismissed", "expired"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_VALUES)[number];
