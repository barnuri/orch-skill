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

export const REAP_AFTER_SECS: number = 600;
const REAP_PATTERN = /dispatch\.sh\s+(run\s+sync|harness\s+list)\b/;

/** `[[dd-]hh:]mm:ss` from ps etime to seconds. */
export function parseEtime(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (m === null) {
    return 0;
  }
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export interface StaleProc {
  pid: number;
  pgid: number;
  age: number;
  command: string;
}

/** Orch `run sync` / `harness list` processes older than maxSecs, from `ps -axo pid,pgid,etime,command`. */
export function findStaleProcs(psOutput: string, maxSecs: number = REAP_AFTER_SECS, self: number = process.pid): StaleProc[] {
  const out: StaleProc[] = [];
  // A child that shares the server's own process group must be killed alone: -pgid would take the server down.
  const selfLine = new RegExp(`^\\s*${self}\\s+(\\d+)\\s`, "m").exec(psOutput);
  const selfPgid = selfLine === null ? -1 : Number(selfLine[1]);
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m === null || Number(m[1]) === self || !REAP_PATTERN.test(m[4] ?? "")) {
      continue;
    }
    const age = parseEtime(m[3] ?? "");
    if (age > maxSecs) {
      const pgid = Number(m[2]);
      out.push({ pid: Number(m[1]), pgid: pgid === selfPgid ? 0 : pgid, age, command: (m[4] ?? "").slice(0, 160) });
    }
  }
  return out;
}

export interface ReapDeps {
  ps: () => Promise<string>;
  kill: (pgid: number, pid: number) => void;
}

/** Kills the process group of every stale orch sync/probe and logs it. Never throws. */
export async function reapStale(deps: ReapDeps, log: (line: string) => void = (l) => process.stderr.write(l)): Promise<number> {
  let n = 0;
  try {
    for (const p of findStaleProcs(await deps.ps())) {
      try {
        deps.kill(p.pgid, p.pid);
        n += 1;
        log(`reaped pid ${p.pid} (pgid ${p.pgid}, ${p.age}s old): ${p.command}\n`);
      } catch (err) {
        log(`reap ${p.pid} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } catch {
    return n;
  }
  return n;
}

async function bunPs(): Promise<string> {
  const proc = Bun.spawn(["ps", "-axo", "pid,pgid,etime,command"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  return await new Response(proc.stdout).text();
}

function killGroup(pgid: number, pid: number): void {
  if (pgid > 1) {
    try {
      process.kill(-pgid, "SIGKILL");
      return;
    } catch {
      // The group is gone or not ours: fall through to the single process.
    }
  }
  process.kill(pid, "SIGKILL");
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

/** The command a pass runs per run: sync without retry, with owner verification (agent owners finish or vanish). */
export function reconcileArgs(runId: string): string[] {
  return ["bash", DISPATCH, "run", "sync", runId, "--no-retry", "--verify-owners", "--lock"];
}

function bunSpawner(home: string): RunSpawner {
  return async (runId, timeoutMs) => {
    const proc = Bun.spawn(reconcileArgs(runId), {
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
  const tick = nonOverlapping(async () => {
    await reapStale({ ps: bunPs, kill: killGroup });
    await reconcileOnce({
      runningRunIds: () => listRuns(paths).filter((r) => r.status === "running").map((r) => r.run_id),
      spawn: bunSpawner(home),
    });
  });
  const first = setTimeout(() => void tick(), FIRST_MS);
  const timer = setInterval(() => void tick(), RECONCILE_MS);
  return {
    stop: (): void => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
