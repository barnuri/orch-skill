import type { AppState } from "./app-state";
import { createInitialState } from "./initial-state";

// The single mutable store. Views read it; poll/editor mutate it and call render().
export const state: AppState = createInitialState();

export function resetRunState(): void {
  state.run = null;
  state.runEtag = null;
  state.runMissing = false;
  state.selectedNode = null;
}

// `profileNames` and `profileHarness` survive: the memory form's datalist and the run graph's
// harness glyphs both reuse the last profiles load.
export function resetDocState(): void {
  state.doc = null;
  state.draft = null;
  state.dirty = false;
  state.drift = false;
  state.editing = null;
  state.fieldIssues = [];
  state.docError = null;
  state.harnesses = null;
  state.harnessesError = null;
}
