import { useSyncExternalStore } from "react";
import { connection } from "../api/status";
import type { ConnectionStatus } from "../api/status";

export function useConnection(): ConnectionStatus {
  return useSyncExternalStore(connection.subscribe, connection.get);
}
