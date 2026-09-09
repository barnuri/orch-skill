import { setToken } from "./api/token-store";
import { poll } from "./poll";
import type { Route } from "./router";
import { state } from "./state/state";
import { renderDocNotices as docNoticesView } from "./views/doc-notices";
import { renderFresh as renderFreshness } from "./views/freshness";
import { renderMemory } from "./views/memory-view";
import { revealNodePanel } from "./views/node-panel";
import { renderNav } from "./views/nav";
import { renderHarnesses } from "./views/harnesses-view";
import { renderProfiles } from "./views/profiles-view";
import { renderSuggestions } from "./views/suggestions-view";
import { renderRun } from "./views/run-view";
import { renderRunsList } from "./views/runs-list-view";
import { renderTokenGate } from "./views/token-gate-view";

const TITLE_PREFIX: string = "orch — ";
const DOC_NOTICES_ID: string = "doc-notices";

function sectionTitle(route: Route): string {
  switch (route.kind) {
    case "list":
      return "runs";
    case "run":
      return state.run === null ? route.runId : state.run.title || state.run.run_id;
    case "profiles":
      return "profiles";
    case "harnesses":
      return "harnesses";
    case "memory":
      return "memory";
    case "suggestions":
      return "suggestions";
  }
}

function renderChrome(route: Route): void {
  renderNav(route);
  renderFreshness(state);
  // Browser tab only — the header brand stays "orch"; section context lives in <main>.
  document.title = `${TITLE_PREFIX}${sectionTitle(route)}`;
}

function selectNode(nodeId: string): void {
  state.selectedNode = nodeId;
  render();
  revealNodePanel();
}

function submitToken(token: string): void {
  setToken(token);
  state.authRequired = false;
  render();
  void poll();
}

function viewFor(route: Route): Node {
  switch (route.kind) {
    case "list":
      return renderRunsList(state);
    case "run":
      return renderRun(state, selectNode);
    case "profiles":
      return renderProfiles(state);
    case "harnesses":
      return renderHarnesses(state);
    case "memory":
      return renderMemory(state);
    case "suggestions":
      return renderSuggestions(state);
  }
}

// Full repaint of <main> plus header chrome. Called on route change, on polls that changed
// something visible, on edit-target transitions and on save outcomes — never from input handlers.
export function render(): void {
  const route = state.route;
  renderChrome(route);
  const main = document.getElementById("main");
  if (main === null) {
    return;
  }
  if (state.authRequired) {
    main.replaceChildren(renderTokenGate(submitToken));
    return;
  }
  main.replaceChildren(viewFor(route));
}

export function renderFresh(): void {
  renderFreshness(state);
}

// Swaps only the `#doc-notices` block a document view rendered, leaving the form (and the
// user's focus) untouched. No-op when no document view is on screen.
export function renderDocNotices(): void {
  const current = document.getElementById(DOC_NOTICES_ID);
  if (current === null) {
    return;
  }
  current.replaceWith(docNoticesView(state));
}
