import type { ApiError } from "../../../shared/types/api-error";

// Every ApiClient call resolves to one of these — it never throws.
export type ApiResult<T> =
  | { kind: "ok"; body: T; etag: string | null }
  | { kind: "unchanged" }
  | { kind: "error"; status: number; body: ApiError | null }
  | { kind: "network" };
