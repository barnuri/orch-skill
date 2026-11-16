import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import { listRuns } from "./runs-reader";
import type { OrchPaths } from "../types/orch-paths";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.ts");
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
  /** Fingerprint of a run's files (state.json + events.jsonl mtimes); null when unreadable. Enables skipping. */
  signature?: (runId: string) => string | null;
  /** Whether the run has a running node; such a run still gets a liveness pass every LIVENESS_MS. */
  hasRunningNode?: (runId: string) => boolean;
  /** Per-run schedule kept between passes. Without it every pass reconciles every run. */
  schedule?: Map<string, RunSchedule>;
  now?: () => number;
}

/** Between passes: what the last good reconcile saw, and when the run may be tried again. */
export interface RunSchedule {
  okSignature: string | null;
  lastRunAt: number;
  intervalMs: number;
  nextAt: number;
  inFlight: boolean;
}

export const LIVENESS_MS: number = 120_000;
export const MAX_BACKOFF_MS: number = 300_000;
/** Bun's `timeout` + SIGKILL ends the child with 137 (or null signal code mapped to it). */
const KILLED_CODE = 137;

function scheduleFor(map: Map<string, RunSchedule>, id: string): RunSchedule {
  let s = map.get(id);
  if (s === undefined) {
    s = { okSignature: null, lastRunAt: 0, intervalMs: RECONCILE_MS, nextAt: 0, inFlight: false };
    map.set(id, s);
  }
  return s;
}

/** Whether this pass should reconcile the run: never twice at once, never before its backoff ends; an unchanged run with a running node every pass (liveness), one without only every LIVENESS_MS. */
export function shouldReconcile(s: RunSchedule, signature: string | null, running: boolean, now: number): boolean {
  if (s.inFlight || now < s.nextAt) {
    return false;
  }
  if (signature === null || signature !== s.okSignature) {
    return true;
  }
  return running || now - s.lastRunAt >= LIVENESS_MS;
}

/**
 * One pass: `run sync --no-retry` for every running run, one at a time. `--no-retry` keeps it
 * read-only toward the work: it flips finished jobs and never dispatches a retry. With a schedule,
 * an unchanged run without a running node is skipped (a liveness pass every LIVENESS_MS), and a
 * timed-out run waits twice as long before the next try, up to MAX_BACKOFF_MS, reset on success.
 */
export async function reconcileOnce(deps: ReconcilerDeps, log: (line: string) => void = (l) => process.stderr.write(l)): Promise<number> {
  let count = 0;
  const now = deps.now ?? Date.now;
  for (const id of deps.runningRunIds()) {
    const s = deps.schedule === undefined ? null : scheduleFor(deps.schedule, id);
    if (s !== null) {
      const sig = deps.signature?.(id) ?? null;
      if (!shouldReconcile(s, sig, deps.hasRunningNode?.(id) ?? true, now())) {
        continue;
      }
      s.inFlight = true;
      s.lastRunAt = now();
    }
    count += 1;
    try {
      const r = await deps.spawn(id, RECONCILE_TIMEOUT_MS);
      if (r.code !== 0) {
        log(`${new Date(now()).toISOString()} run reconcile ${id} failed (${r.code}): ${r.stderr.trim()}\n`);
      }
      if (s !== null) {
        if (r.code === KILLED_CODE) {
          s.intervalMs = Math.min(s.intervalMs * 2, MAX_BACKOFF_MS);
          s.nextAt = now() + s.intervalMs;
        } else {
          s.intervalMs = RECONCILE_MS;
          s.nextAt = 0;
          // Taken after the pass: the sync's own writes must not count as a change next time.
          s.okSignature = r.code === 0 ? (deps.signature?.(id) ?? null) : null;
        }
      }
    } catch (err) {
      log(`${new Date(now()).toISOString()} run reconcile ${id} error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      if (s !== null) {
        s.inFlight = false;
      }
    }
  }
  return count;
}

/** state.json + events.jsonl mtimes of a run; null when the state cannot be read. */
export function runSignature(runsDir: string, runId: string): string | null {
  const mtime = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const state = mtime(join(runsDir, runId, "state.json"));
  return state === 0 ? null : `${state}:${mtime(join(runsDir, runId, "events.jsonl"))}`;
}

export const REAP_AFTER_SECS: number = 600;
const REAP_PATTERN = /dispatch\.ts\s+(run\s+sync|harness\s+list)\b/;

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
  return [process.execPath, DISPATCH, "run", "sync", runId, "--no-retry", "--verify-owners", "--lock"];
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
  const schedule = new Map<string, RunSchedule>();
  const tick = nonOverlapping(async () => {
    await reapStale({ ps: bunPs, kill: killGroup });
    const runs = listRuns(paths).filter((r) => r.status === "running");
    const running = new Map(runs.map((r) => [r.run_id, (r.counts.running ?? 0) > 0]));
    await reconcileOnce({
      runningRunIds: () => runs.map((r) => r.run_id),
      spawn: bunSpawner(home),
      signature: (id) => runSignature(paths.runs, id),
      hasRunningNode: (id) => running.get(id) ?? true,
      schedule,
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
