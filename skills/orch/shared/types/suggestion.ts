import type { ConfidenceTier, SuggestionStatus } from "./routing-enums";

export interface SuggestionEvidence {
  type: string;
  id?: string;
  node?: string;
  ts?: string;
}

export interface SuggestionAction {
  type: string;
  profile?: string;
  model_id?: string;
  description?: string;
  set?: Record<string, unknown>;
  memory?: {
    profile: string;
    outcome: string;
    task_kind?: string;
    note?: string;
    model_id?: string;
  };
}

export interface Suggestion {
  id: string;
  status: SuggestionStatus;
  created: string;
  confidence: ConfidenceTier;
  kind: string;
  title: string;
  reason: string;
  evidence: SuggestionEvidence[];
  action: SuggestionAction;
  fingerprint: string;
}
