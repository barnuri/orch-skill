import type { LearningSettings } from "./learning-settings";

export interface ProfilesSettings {
  default_profile?: string;
  retention_days?: number;
  budget_threshold?: number;
  learning?: LearningSettings;
  /** Harness ids hidden from profile pickers (adapters remain in code). */
  disabled_harnesses?: string[];
}
