import { useSyncExternalStore } from "react";
import { connection } from "../api/status";
import type { ConnectionStatus } from "../api/status";

export function useConnection(): ConnectionStatus {
  return useSyncExternalStore(connection.subscribe, connection.get);
}

const authRequired = (): boolean => connection.get().authRequired;

/**
 * Only the token-gate flag. Every successful GET replaces the status object (new `lastOkAt`), so a
 * caller of useConnection re-renders on each poll; the shell must not, or every page re-renders with it.
 */
export function useAuthRequired(): boolean {
  return useSyncExternalStore(connection.subscribe, authRequired);
}
