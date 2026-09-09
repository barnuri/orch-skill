import type { AppState } from "./app-state";
import { loadRunFilters } from "./run-filters";

export function createInitialState(): AppState {
  return {
    route: { kind: "list" },
    runs: null,
    runsEtag: null,
    runFilters: loadRunFilters(),
    run: null,
    runEtag: null,
    runMissing: false,
    selectedNode: null,
    lastOkAt: null,
    lastError: null,
    authRequired: false,
    doc: null,
    draft: null,
    dirty: false,
    drift: false,
    editing: null,
    fieldIssues: [],
    docError: null,
    profileNames: [],
    profileHarness: {},
    defaultProfile: "",
    pendingProfileEdit: null,
    harnesses: null,
    harnessesError: null,
  };
}
