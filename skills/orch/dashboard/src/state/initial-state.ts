import type { AppState } from "./app-state";

export function createInitialState(): AppState {
  return {
    route: { kind: "list" },
    runs: null,
    runsEtag: null,
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
    defaultProfile: "",
  };
}
