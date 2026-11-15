import { useSyncExternalStore } from "react";

const TICK_MS = 1000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  now = Date.now();
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) {
        notify();
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const idle = (): (() => void) => () => undefined;

/** Number of subscribers to the shared ticker (one interval serves every live value on screen). */
export function tickerListeners(): number {
  return listeners.size;
}

/**
 * Re-renders the caller once a second while `live`, off ONE shared interval. Callers recompute their
 * text from `Date.now()` when this changes; a finished value passes `live` false and never ticks.
 */
export function useNow(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : idle, () => (live ? now : 0), () => 0);
}
