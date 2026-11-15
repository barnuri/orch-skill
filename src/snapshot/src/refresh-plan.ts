import type { DocumentKind } from "../../shared/types/document-kind";
import type { Route } from "./router";

/** What the refresh button must drop or force so the current page shows fresh data from the server. */
export interface RefreshPlan {
  /** Cached conditional-GET tags to clear, so the next poll cannot answer "304 unchanged". */
  etags: ReadonlyArray<"runs" | "active" | "run" | "schedules">;
  /** The document slice whose etag to clear, if the page edits one. */
  document: DocumentKind | null;
  /** Skip the server's short harness-probe cache, as the Re-detect button does. */
  forceHarnesses: boolean;
}

// The active-items pill is on every page, so its tag is always cleared.
export function refreshPlanFor(route: Route): RefreshPlan {
  switch (route.kind) {
    case "list":
      return { etags: ["active", "runs"], document: null, forceHarnesses: false };
    case "run":
      return { etags: ["active", "run"], document: null, forceHarnesses: false };
    case "schedules":
      return { etags: ["active", "schedules"], document: null, forceHarnesses: false };
    case "harnesses":
      // The page shows harnesses and which are disabled, and that comes from profiles.json.
      return { etags: ["active"], document: "profiles", forceHarnesses: true };
    case "profiles":
    case "memory":
    case "suggestions":
      return { etags: ["active"], document: route.kind, forceHarnesses: false };
  }
}
