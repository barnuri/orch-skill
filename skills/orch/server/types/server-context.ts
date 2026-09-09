import type { OrchPaths } from "./orch-paths";

export interface ServerContext {
  paths: OrchPaths;
  bindHost: string;
  hostname: string;
  tokenDigest: Uint8Array;
  requireToken: boolean;
  requireRemoteToken: boolean;
  harnesses: readonly string[];
  outcomes: readonly string[];
}
