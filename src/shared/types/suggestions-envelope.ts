import type { DocumentEnvelope } from "./document-envelope";
import type { SuggestionsDocument } from "./suggestions-document";

export interface SuggestionsEnvelope extends DocumentEnvelope<SuggestionsDocument> {
  kinds: string[];
}
