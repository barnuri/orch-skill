import type { DocumentKind } from "../../shared/types/document-kind";
import type { MemoryEnvelope } from "../../shared/types/memory-envelope";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import type { ProfilesEnvelope } from "../../shared/types/profiles-envelope";
import type { SuggestionsEnvelope } from "../../shared/types/suggestions-envelope";
import { ApiClient } from "./api/api-client";
import type { ApiResult } from "./api/api-result";
import { refreshHarnesses } from "./views/harnesses-panel";
import { render, renderDocNotices } from "./render";
import type { Route } from "./router";
import { beginEdit } from "./forms/document-editor";
import { applyDocLoad } from "./state/doc-reducer";
import type { LoadedDocument } from "./state/loaded-document";
import { state } from "./state/state";

type NonOkResult = Exclude<ApiResult<unknown>, { kind: "ok" }>;
type DocumentEnvelope = ProfilesEnvelope | MemoryEnvelope | SuggestionsEnvelope;

const NETWORK_ERROR: string =
  "dashboard offline — orch CLI still works on disk; run orch sync when the server is back";
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_NOT_FOUND = 404;

const api = new ApiClient();

// Only the most recently issued poll may touch state: a slow response for a route the user has
// already left (or an older tick of the same route) is dropped instead of applied.
let latestPoll = 0;

function isCurrent(seq: number): boolean {
  return seq === latestPoll;
}

// 200 and 304 both prove the server is up and the token is accepted.
function markOk(): boolean {
  const gateCleared = state.authRequired;
  state.lastOkAt = Date.now();
  state.lastError = null;
  state.authRequired = false;
  return gateCleared;
}

// Re-render only on transitions, so a server that stays down (or a gate the user is typing
// into) is not rebuilt every 2 s.
function fail(message: string): void {
  if (state.lastError === message) {
    return;
  }
  state.lastError = message;
  render();
}

function applyNonOk(result: NonOkResult): void {
  if (result.kind === "unchanged") {
    if (markOk()) {
      render();
    }
    return;
  }
  if (result.kind === "network") {
    fail(NETWORK_ERROR);
    return;
  }
  if (result.status === HTTP_STATUS_UNAUTHORIZED) {
    if (!state.authRequired) {
      state.authRequired = true;
      render();
    }
    return;
  }
  fail(result.body?.error ?? `HTTP ${result.status}`);
}

async function pollRuns(seq: number): Promise<void> {
  const result = await api.getRuns(state.runsEtag);
  if (!isCurrent(seq)) {
    return;
  }
  if (result.kind !== "ok") {
    applyNonOk(result);
    return;
  }
  state.runs = result.body.runs;
  state.runsEtag = result.etag;
  markOk();
  render();
}

function harnessByProfile(profiles: ProfilesDocument["profiles"]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, spec] of Object.entries(profiles)) {
    if (typeof spec.harness === "string" && spec.harness !== "") {
      map[name] = spec.harness;
    }
  }
  return map;
}

/**
 * A run page never polls profiles.json, but it needs profile -> harness to pick each node's
 * glyph. Fetched once on entering the route; a node dispatched for real carries its own
 * `adapter`, so this only fills in nodes that are still waiting on their profile.
 */
async function loadProfileHarnesses(): Promise<void> {
  if (Object.keys(state.profileHarness).length > 0) {
    return;
  }
  const result = await api.getDocument<ProfilesEnvelope>("profiles", null);
  if (result.kind !== "ok" || result.body.document === null) {
    return;
  }
  state.profileHarness = harnessByProfile(result.body.document.profiles);
}

async function pollRun(runId: string, seq: number): Promise<void> {
  const result = await api.getRun(runId, state.runEtag);
  if (!isCurrent(seq)) {
    return;
  }
  if (result.kind === "error" && result.status === HTTP_STATUS_NOT_FOUND) {
    if (!state.runMissing) {
      state.runMissing = true;
      state.run = null;
      render();
    }
    return;
  }
  if (result.kind !== "ok") {
    applyNonOk(result);
    return;
  }
  state.run = result.body.run;
  state.runEtag = result.etag;
  state.runMissing = false;
  markOk();
  render();
}

function toLoadedDocument(kind: DocumentKind, body: DocumentEnvelope, etag: string | null): LoadedDocument {
  const enums =
    "harnesses" in body ? body.harnesses : "kinds" in body ? body.kinds : body.outcomes;
  return {
    kind,
    document: body.document,
    etag: etag ?? "",
    enums,
    issues: body.issues,
    maxBodyBytes: body.limits.max_body_bytes,
  };
}

function fetchDocument(kind: DocumentKind, etag: string | null): Promise<ApiResult<DocumentEnvelope>> {
  if (kind === "profiles") {
    return api.getDocument<ProfilesEnvelope>(kind, etag);
  }
  if (kind === "suggestions") {
    return api.getDocument<SuggestionsEnvelope>(kind, etag);
  }
  return api.getDocument<MemoryEnvelope>(kind, etag);
}

async function pollDocument(kind: DocumentKind, seq: number): Promise<void> {
  const etag = state.doc?.kind === kind ? state.doc.etag : null;
  const result = await fetchDocument(kind, etag);
  if (!isCurrent(seq)) {
    return;
  }
  if (result.kind !== "ok") {
    applyNonOk(result);
    return;
  }
  if (result.body.document !== null && "harnesses" in result.body && "profiles" in result.body.document) {
    state.profileNames = Object.keys(result.body.document.profiles);
    state.profileHarness = harnessByProfile(result.body.document.profiles);
    state.defaultProfile = result.body.document.settings.default_profile ?? "";
  }
  const outcome = applyDocLoad({ doc: state.doc, dirty: state.dirty }, toLoadedDocument(kind, result.body, result.etag));
  const driftStarted = outcome.drift && !state.drift;
  state.doc = outcome.doc;
  state.drift = outcome.drift;
  const gateCleared = markOk();
  let openedProfile = false;
  if (kind === "profiles" && state.pendingProfileEdit !== null && outcome.doc !== null) {
    const name = state.pendingProfileEdit;
    state.pendingProfileEdit = null;
    beginEdit(name);
    openedProfile = true;
  }
  if (outcome.rerender || gateCleared || openedProfile) {
    render();
    return;
  }
  if (driftStarted) {
    renderDocNotices();
  }
}

async function pollHarnesses(seq: number): Promise<void> {
  await pollDocument("profiles", seq);
  if (!isCurrent(seq)) {
    return;
  }
  await refreshHarnesses();
}

function pollRoute(route: Route, seq: number): Promise<void> {
  switch (route.kind) {
    case "list":
      return pollRuns(seq);
    case "run":
      void loadProfileHarnesses();
      return pollRun(route.runId, seq);
    case "harnesses":
      return pollHarnesses(seq);
    case "profiles":
    case "memory":
    case "suggestions":
      return pollDocument(route.kind, seq);
  }
}

// Clears the cached etag so the next poll refetches — needed after dispatch-side mutations
// (suggest apply/dismiss/scan) that bypass the dashboard PUT path.
export function invalidateDocument(kind: DocumentKind): void {
  if (state.doc?.kind === kind) {
    state.doc.etag = "";
  }
}

// One conditional GET for the current route; every outcome lands in `state` (see the
// live-update decision): 200 apply, 304 freshness only, 401 gate, 404 missing run, else error.
export function poll(): Promise<void> {
  latestPoll += 1;
  return pollRoute(state.route, latestPoll);
}
