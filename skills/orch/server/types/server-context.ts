import type { OrchPaths } from "./orch-paths";

export interface ServerContext {
  paths: OrchPaths;
  bindHost: string;
  hostname: string;
  tokenDigest: Uint8Array;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
