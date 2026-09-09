export type Route =
  | { kind: "list" }
  | { kind: "run"; runId: string }
  | { kind: "profiles" }
  | { kind: "memory" };

const RUN_HASH = /^#\/run\/(.+)$/;
const PROFILES_HASH: string = "#/profiles";
const MEMORY_HASH: string = "#/memory";

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
  if (hash === MEMORY_HASH) {
    return { kind: "memory" };
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
