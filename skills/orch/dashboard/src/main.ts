import { adoptTokenFromUrl } from "./api/token-store";
import { FRESH_TICK_MS, POLL_MS } from "./constants";
import { poll } from "./poll";
import { render, renderFresh } from "./render";
import { parseRoute, routeKey } from "./router";
import type { Route } from "./router";
import { resetDocState, resetRunState, state } from "./state/state";
import { applyStoredTheme, toggleTheme } from "./theme";

function enterRoute(route: Route): void {
  state.route = route;
  resetRunState();
  resetDocState();
  render();
  void poll();
}

// `#` → `#/` and friends fire hashchange without changing the route; keep the slices then.
function onHashChange(): void {
  const next = parseRoute(location.hash);
  if (routeKey(next) === routeKey(state.route)) {
    return;
  }
  enterRoute(next);
}

function wireTheme(): void {
  const button = document.getElementById("theme");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  applyStoredTheme(button);
  button.addEventListener("click", () => {
    toggleTheme(button);
  });
}

function boot(): void {
  wireTheme();
  adoptTokenFromUrl();
  window.addEventListener("hashchange", onHashChange);
  enterRoute(parseRoute(location.hash));
  setInterval(() => {
    void poll();
  }, POLL_MS);
  setInterval(renderFresh, FRESH_TICK_MS);
}

boot();
