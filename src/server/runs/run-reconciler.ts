import { resolve } from "node:path";

import { listRuns } from "./runs-reader";
import type { OrchPaths } from "../types/orch-paths";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
export const RECONCILE_MS: number = 30_000;
export const RECONCILE_TIMEOUT_MS: number = 20_000;
const FIRST_MS: number = 8_000;

export interface Reconciler {
  stop(): void;
}

export type RunSpawner = (runId: string, timeoutMs: number) => Promise<{ code: number; stderr: string }>;

export interface ReconcilerDeps {
  runningRunIds: () => string[];
  spawn: RunSpawner;
}

/**
 * One pass: `run sync --no-retry` for every running run, one at a time. `--no-retry` keeps it
 * read-only toward the work: it flips finished jobs and never dispatches a retry.
 */
export async function reconcileOnce(deps: ReconcilerDeps, log: (line: string) => void = (l) => process.stderr.write(l)): Promise<number> {
  let count = 0;
  for (const id of deps.runningRunIds()) {
    count += 1;
    try {
      const r = await deps.spawn(id, RECONCILE_TIMEOUT_MS);
      if (r.code !== 0) {
        log(`run reconcile ${id} failed (${r.code}): ${r.stderr.trim()}\n`);
      }
    } catch (err) {
      log(`run reconcile ${id} error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return count;
}

/** Wraps a pass so a slow one is never stacked on itself. */
export function nonOverlapping(pass: () => Promise<unknown>): () => Promise<void> {
  let busy = false;
  return async (): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await pass();
    } finally {
      busy = false;
    }
  };
}

function bunSpawner(home: string): RunSpawner {
  return async (runId, timeoutMs) => {
    const proc = Bun.spawn(["bash", DISPATCH, "run", "sync", runId, "--no-retry"], {
      env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "reconciler", ORCH_NO_ANNOUNCE: "1" },
      stdout: "ignore",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr: err };
  };
}

export function startReconciler(home: string, paths: OrchPaths): Reconciler {
  const tick = nonOverlapping(() =>
    reconcileOnce({
      runningRunIds: () => listRuns(paths).filter((r) => r.status === "running").map((r) => r.run_id),
      spawn: bunSpawner(home),
    }),
  );
  const first = setTimeout(() => void tick(), FIRST_MS);
  const timer = setInterval(() => void tick(), RECONCILE_MS);
  return {
    stop: (): void => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
