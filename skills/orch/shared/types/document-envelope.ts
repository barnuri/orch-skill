import type { Issue } from "./issue";

export interface DocumentEnvelope<T> {
  document: T | null;
  issues: Issue[];
  limits: { max_body_bytes: number };
}
