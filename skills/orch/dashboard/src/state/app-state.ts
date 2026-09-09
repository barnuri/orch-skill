import type { HarnessStatus } from "../../../shared/types/harness-status";
import type { Issue } from "../../../shared/types/issue";
import type { MemoryDocument } from "../../../shared/types/memory-document";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import type { SuggestionsDocument } from "../../../shared/types/suggestions-document";
import type { RunState } from "../../../shared/types/run-state";
import type { RunSummary } from "../../../shared/types/run-summary";
import type { Route } from "../router";
import type { EditingTarget } from "./editing-target";
import type { LoadedDocument } from "./loaded-document";
import type { RunFilters } from "./run-filters";

export interface AppState {
  route: Route;
  // Runs list slice (kept across navigations so the list paints instantly and the first poll 304s).
  runs: RunSummary[] | null;
  runsEtag: string | null;
  /** Runs-list view filters. Persisted to localStorage, so they outlive a reload. */
  runFilters: RunFilters;
  // Single-run slice (reset on every route change).
  run: RunState | null;
  runEtag: string | null;
  runMissing: boolean;
  selectedNode: string | null;
  // Freshness / connectivity.
  lastOkAt: number | null;
  lastError: string | null;
  authRequired: boolean;
  // Document editor slice (reset on every route change).
  doc: LoadedDocument | null;
  draft: ProfilesDocument | MemoryDocument | SuggestionsDocument | null;
  dirty: boolean;
  drift: boolean;
  editing: EditingTarget;
  fieldIssues: Issue[];
  docError: string | null;
  profileNames: string[];
  /** profile name -> harness id, so a run page can pick each node's harness glyph. */
  profileHarness: Record<string, string>;
  defaultProfile: string;
  /** Set before navigating to #/profiles; consumed on the next profiles poll. */
  pendingProfileEdit: string | null;
  harnesses: HarnessStatus[] | null;
  harnessesError: string | null;
}
