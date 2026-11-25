import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every server path that runs dispatch.ts on its own must mark it as an orch dispatch, so the job runs in the node's
// or run's repo and never in the service's cwd (the orch-skill checkout). verify-G17 found the auto-dispatch engine missing it.
test("server-side dispatchers set ORCH_AUTO_DISPATCH", () => {
  for (const f of ["runs/auto-dispatch.ts", "watchdog/watchdog-service.ts", "health/health-watcher.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
    expect(src.includes('ORCH_AUTO_DISPATCH: "1"')).toBe(true);
  }
});
