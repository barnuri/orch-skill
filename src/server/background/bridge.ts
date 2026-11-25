import type { WatchdogStatus } from "../../shared/types/watchdog";

/** Messages the background worker posts to the API process. */
export type WorkerMessage =
  | { type: "watchdog"; status: WatchdogStatus }
  | { type: "herdr"; health: unknown }
  | { type: "notify"; category: string; input: unknown }
  | { type: "ready" };

/** Messages the API process posts to the background worker. */
export type MainMessage = { type: "start"; home: string };

const watchdog = new Map<string, { at: number; status: WatchdogStatus }>();

/** A snapshot older than this is not served: the worker is gone, so the route falls back to its own (idle) service. */
export const SNAPSHOT_MAX_AGE_MS: number = 60_000;

export function setRemoteWatchdogStatus(home: string, status: WatchdogStatus): void {
  watchdog.set(home, { at: Date.now(), status });
}

export function remoteWatchdogStatus(home: string): WatchdogStatus | null {
  const hit = watchdog.get(home);
  return hit !== undefined && Date.now() - hit.at < SNAPSHOT_MAX_AGE_MS ? hit.status : null;
}

export function clearRemoteWatchdogStatus(home: string): void {
  watchdog.delete(home);
}
