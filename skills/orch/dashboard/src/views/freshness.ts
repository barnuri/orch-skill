import { DEAD_MS, STALE_MS } from "../constants";
import { ago } from "../dom/format";
import type { AppState } from "../state/app-state";

const WAITING_TEXT: string = "waiting for data…";

function levelClass(ageMs: number, lastError: string | null): string {
  if (lastError !== null || ageMs > DEAD_MS) {
    return " dead";
  }
  return ageMs > STALE_MS ? " stale" : "";
}

// Header dot + text. Driven by the last successful poll (200 or 304), not by payload timestamps.
export function renderFresh(state: AppState): void {
  const root = document.getElementById("fresh");
  const text = document.getElementById("fresh-text");
  if (root === null || text === null) {
    return;
  }
  if (state.lastOkAt === null) {
    root.className = "fresh dead";
    text.textContent = WAITING_TEXT;
    return;
  }
  root.className = `fresh${levelClass(Date.now() - state.lastOkAt, state.lastError)}`;
  text.textContent = `updated ${ago(state.lastOkAt)}`;
}
