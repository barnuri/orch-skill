import type { DocumentKind } from "../../../shared/types/document-kind";
import type { Issue } from "../../../shared/types/issue";
import type { MemoryDocument } from "../../../shared/types/memory-document";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";

// One GET /api/<kind> envelope flattened for the editor: `enums` is `harnesses` or `outcomes`.
export interface LoadedDocument {
  kind: DocumentKind;
  document: ProfilesDocument | MemoryDocument | null;
  etag: string;
  enums: string[];
  issues: Issue[];
  maxBodyBytes: number;
}
