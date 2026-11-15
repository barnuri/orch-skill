import type { DocumentEnvelope } from "./document-envelope";
import type { MemoryDocument } from "./memory-document";

export interface MemoryEnvelope extends DocumentEnvelope<MemoryDocument> {
  outcomes: string[];
}
