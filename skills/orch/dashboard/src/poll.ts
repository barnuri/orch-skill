import type { DocumentKind } from "../../shared/types/document-kind";
import type { MemoryEnvelope } from "../../shared/types/memory-envelope";
import type { ProfilesEnvelope } from "../../shared/types/profiles-envelope";
import { ApiClient } from "./api/api-client";
import type { ApiResult } from "./api/api-result";
import { render, renderDocNotices } from "./render";
import type { Route } from "./router";
import { applyDocLoad } from "./state/doc-reducer";
import type { LoadedDocument } from "./state/loaded-document";
import { state } from "./state/state";

type NonOkResult = Exclude<ApiResult<unknown>, { kind: "ok" }>;
type DocumentEnvelope = ProfilesEnvelope | MemoryEnvelope;

const NETWORK_ERROR: string = "cannot reach the server";
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
  return {
    kind,
    document: body.document,
    etag: etag ?? "",
    enums: "harnesses" in body ? body.harnesses : body.outcomes,
    issues: body.issues,
    maxBodyBytes: body.limits.max_body_bytes,
  };
}

function fetchDocument(kind: DocumentKind, etag: string | null): Promise<ApiResult<DocumentEnvelope>> {
  return kind === "profiles"
    ? api.getDocument<ProfilesEnvelope>(kind, etag)
    : api.getDocument<MemoryEnvelope>(kind, etag);
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
  if (result.body.document !== null && "harnesses" in result.body) {
    state.profileNames = Object.keys(result.body.document.profiles);
    state.defaultProfile = result.body.document.settings.default_profile ?? "";
  }
  const outcome = applyDocLoad({ doc: state.doc, dirty: state.dirty }, toLoadedDocument(kind, result.body, result.etag));
  const driftStarted = outcome.drift && !state.drift;
  state.doc = outcome.doc;
  state.drift = outcome.drift;
  const gateCleared = markOk();
  if (outcome.rerender || gateCleared) {
    render();
    return;
  }
  if (driftStarted) {
    renderDocNotices();
  }
}

function pollRoute(route: Route, seq: number): Promise<void> {
  switch (route.kind) {
    case "list":
      return pollRuns(seq);
    case "run":
      return pollRun(route.runId, seq);
    case "profiles":
    case "memory":
      return pollDocument(route.kind, seq);
  }
}

// One conditional GET for the current route; every outcome lands in `state` (see the
// live-update decision): 200 apply, 304 freshness only, 401 gate, 404 missing run, else error.
export function poll(): Promise<void> {
  latestPoll += 1;
  return pollRoute(state.route, latestPoll);
}
