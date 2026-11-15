import type { ApiError } from "../../shared/types/api-error";

// Every ApiClient call resolves to one of these: it never throws.
export type ApiResult<T> =
  | { kind: "ok"; body: T; etag: string | null }
  | { kind: "unchanged" }
  | { kind: "error"; status: number; body: ApiError | null }
  | { kind: "invalid"; message: string }
  | { kind: "network" };

export type NonOk = Exclude<ApiResult<unknown>, { kind: "ok" }>;

export const NETWORK_ERROR = "dashboard offline — orch CLI still works on disk; run orch sync when the server is back";

/** One sentence for any non-ok outcome, for toasts and notices. */
export function describeFailure(result: NonOk, fallback: string): string {
  switch (result.kind) {
    case "error":
      return result.body?.error ?? `${fallback} (${result.status})`;
    case "invalid":
      return result.message;
    case "network":
      return "could not reach the dashboard";
    case "unchanged":
      return fallback;
  }
}
