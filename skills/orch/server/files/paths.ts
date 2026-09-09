import { join } from "node:path";

import type { OrchPaths } from "../types/orch-paths";

export function orchPaths(home: string): OrchPaths {
  const serveDir = join(home, "serve");
  return {
    home,
    profiles: join(home, "profiles.json"),
    memory: join(home, "memory.json"),
    suggestions: join(home, "suggestions.json"),
    runs: join(home, "runs"),
    serveDir,
    pidFile: join(serveDir, "pid"),
    portFile: join(serveDir, "port"),
    hostFile: join(serveDir, "host"),
    tokenFile: join(home, "serve.token"),
    trash: join(home, ".trash"),
  };
}
