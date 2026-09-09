export interface SuggestionApplyResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface SuggestionApplyEnvelope {
  ok: boolean;
  applied: number;
  failed: number;
  results: SuggestionApplyResult[];
}
