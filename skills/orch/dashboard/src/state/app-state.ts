import type { Issue } from "../../../shared/types/issue";
import type { MemoryDocument } from "../../../shared/types/memory-document";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import type { RunState } from "../../../shared/types/run-state";
import type { RunSummary } from "../../../shared/types/run-summary";
import type { Route } from "../router";
import type { EditingTarget } from "./editing-target";
import type { LoadedDocument } from "./loaded-document";

export interface AppState {
  route: Route;
  // Runs list slice (kept across navigations so the list paints instantly and the first poll 304s).
  runs: RunSummary[] | null;
  runsEtag: string | null;
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
  draft: ProfilesDocument | MemoryDocument | null;
  dirty: boolean;
  drift: boolean;
  editing: EditingTarget;
  fieldIssues: Issue[];
  docError: string | null;
  profileNames: string[];
  defaultProfile: string;
}
