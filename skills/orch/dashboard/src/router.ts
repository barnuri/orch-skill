export type Route =
  | { kind: "list" }
  | { kind: "run"; runId: string }
  | { kind: "profiles" }
  | { kind: "harnesses" }
  | { kind: "memory" }
  | { kind: "suggestions" };

const RUN_HASH = /^#\/run\/(.+)$/;
const PROFILES_HASH: string = "#/profiles";
const HARNESSES_HASH: string = "#/harnesses";
const MEMORY_HASH: string = "#/memory";
const SUGGESTIONS_HASH: string = "#/suggestions";

// The hash is user-controlled: a malformed escape must fall back to the list, not throw.
function decodeRunId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    if (err instanceof URIError) {
      return null;
    }
    throw err;
  }
}

export function parseRoute(hash: string): Route {
  if (hash === PROFILES_HASH) {
    return { kind: "profiles" };
  }
  if (hash === HARNESSES_HASH) {
    return { kind: "harnesses" };
  }
  if (hash === MEMORY_HASH) {
    return { kind: "memory" };
  }
  if (hash === SUGGESTIONS_HASH) {
    return { kind: "suggestions" };
  }
  const match = RUN_HASH.exec(hash);
  const runId = match?.[1] === undefined ? null : decodeRunId(match[1]);
  if (runId === null || runId === "") {
    return { kind: "list" };
  }
  return { kind: "run", runId };
}

// Stable identity for "did the route actually change" checks and stale-poll detection.
export function routeKey(route: Route): string {
  return route.kind === "run" ? `run:${route.runId}` : route.kind;
}
