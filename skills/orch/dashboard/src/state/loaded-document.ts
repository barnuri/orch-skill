import type { DocumentKind } from "../../../shared/types/document-kind";
import type { Issue } from "../../../shared/types/issue";
import type { MemoryDocument } from "../../../shared/types/memory-document";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import type { SuggestionsDocument } from "../../../shared/types/suggestions-document";

// One GET /api/<kind> envelope flattened for the editor: `enums` is `harnesses`, `outcomes` or `kinds`.
export interface LoadedDocument {
  kind: DocumentKind;
  document: ProfilesDocument | MemoryDocument | SuggestionsDocument | null;
  etag: string;
  enums: string[];
  issues: Issue[];
  maxBodyBytes: number;
}
