// Shared helpers for the coordinator shortcut scripts (o.ts, run-nodes.ts, job-tail.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RUN_ID_FILE = process.env["ORCH_RUN_ID_FILE"] ?? "/tmp/orch-run-id";

export function orchHome(): string {
  return process.env["HARNESS_ORCH_HOME"] ?? join(process.env["HOME"] ?? "", ".harness-orch");
}

export interface NodeState { id: string; status: string; goal?: string; job?: string }
export interface RunState { status?: string; paused?: boolean; auto_resume?: boolean; nodes?: NodeState[] }

// Run id order: explicit arg (other than "@run"), $ORCH_RUN_ID, the run id file, newest running run.
export function resolveRun(arg: string | undefined, home = orchHome()): string {
  if (arg !== undefined && arg !== "@run") return arg;
  const env = process.env["ORCH_RUN_ID"];
  if (env) return env;
  if (existsSync(RUN_ID_FILE)) {
    const id = readFileSync(RUN_ID_FILE, "utf8").trim();
    if (id) return id;
  }
  const runs = join(home, "runs");
  const dirs = existsSync(runs) ? readdirSync(runs).filter((d) => existsSync(join(runs, d, "state.json"))).sort().reverse() : [];
  for (const d of dirs) if (readState(d, home).status === "running") return d;
  if (dirs[0] === undefined) throw new Error("no run found: pass a run id or write it to " + RUN_ID_FILE);
  return dirs[0];
}

export function readState(run: string, home = orchHome()): RunState {
  return JSON.parse(readFileSync(join(home, "runs", run, "state.json"), "utf8")) as RunState;
}
