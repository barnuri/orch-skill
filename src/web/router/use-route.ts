import { useMemo, useSyncExternalStore } from "react";
import { parseRoute, routeKey } from "./route";
import type { Route } from "./route";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
  };
}

const snapshot = (): string => location.hash;

// `#` -> `#/` and friends fire hashchange without changing the route; the memo keeps the
// route object (and so every page keyed on it) stable then.
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  const route = parseRoute(hash);
  const key = routeKey(route);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => route, [key]);
}
