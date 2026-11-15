import type { Suggestion } from "./suggestion";

export interface SuggestionsDocument {
  generated_at: string;
  suggestions: Suggestion[];
}
