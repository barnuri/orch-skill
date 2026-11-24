// Rotates the orchestrator of each running run once its context reaches settings.coordinator_rotate_tokens.
// Every ROTATION_CHECK_MS it runs `dispatch.ts orchestrator check <run>` per running run that has a coordinator
// session. The check reads the session's prompt size from opencode.db and does the rotation itself.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchPath } from "../dispatch-path";

export const ROTATION_CHECK_MS: number = 5 * 60_000;

type Starter = (args: string[], home: string) => Promise<number>;

interface RotationRun {
  status?: string;
  paused?: boolean;
  stopped?: boolean;
  coordinator?: { session_id?: unknown } | null;
}

/** Run ids whose state is running, not paused or stopped, and which have a coordinator session. */
export function rotationCandidates(home: string): string[] {
  const dir = join(home, "runs");
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch {
    return [];
  }
  return ids.filter((id) => {
    let state: RotationRun;
    try {
      state = JSON.parse(readFileSync(join(dir, id, "state.json"), "utf8")) as RotationRun;
    } catch {
      return false;
    }
    const session = state.coordinator?.session_id;
    return state.status === "running" && state.paused !== true && state.stopped !== true && typeof session === "string" && session !== "";
  });
}

export const spawnOrchestratorCheck: Starter = async (args, home) => {
  const proc = Bun.spawn([process.execPath, dispatchPath(), ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "watchdog", ORCH_NO_ANNOUNCE: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
};

export interface RotationOptions {
  run?: Starter;
  everyMs?: number;
}

/** Starts the timer. Returns a stop function. A check still running is not started again. */
export function startOrchestratorRotation(home: string, opts: RotationOptions = {}): () => void {
  const run = opts.run ?? spawnOrchestratorCheck;
  const busy = new Set<string>();
  const pass = (): void => {
    for (const id of rotationCandidates(home)) {
      if (busy.has(id)) continue;
      busy.add(id);
      run(["orchestrator", "check", id], home)
        .catch(() => -1)
        .finally(() => busy.delete(id));
    }
  };
  const timer = setInterval(pass, opts.everyMs ?? ROTATION_CHECK_MS);
  return () => clearInterval(timer);
}
