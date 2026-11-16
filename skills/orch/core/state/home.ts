// Orch home resolution. Bun built-ins only. Matches dispatch.ts: HARNESS_ORCH_HOME, else $HOME/.harness-orch.
import { join } from "node:path";
import { homedir } from "node:os";

export function orchHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_ORCH_HOME || join(env.HOME || homedir(), ".harness-orch");
}

export const paths = {
  locks: (home: string) => join(home, "locks"),
  runs: (home: string) => join(home, "runs"),
  runState: (home: string, runId: string) => join(home, "runs", runId, "state.json"),
  runEvents: (home: string, runId: string) => join(home, "runs", runId, "events.jsonl"),
  runOutDir: (home: string, runId: string, nodeId: string) => join(home, "runs", runId, "out", nodeId),
  jobs: (home: string) => join(home, "jobs"),
  profiles: (home: string) => join(home, "profiles.json"),
  owners: (home: string) => join(home, "owners"),
  currentRun: (home: string) => join(home, "current-run"),
  trash: (home: string) => join(home, ".trash"),
};
