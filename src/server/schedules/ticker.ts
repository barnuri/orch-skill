import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dispatchPath } from "../dispatch-path";

export const TICK_MS: number = 30_000;
const FIRST_TICK_MS: number = 5_000;
// A claimed fire gets this long to show up as a run before it is counted as lost: the tick it
// spawned is detached and may still be working when the server comes back.
export const CATCHUP_GRACE_MS: number = 60_000;
// Fires older than this are not caught up: a long outage skips them instead of replaying them.
const CATCHUP_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

export interface Ticker {
  stop(): void;
}

interface ScheduleFile {
  enabled?: boolean;
  next_at?: number | null;
  runs?: { started_at?: string; status?: string }[];
}

type Spawner = (args: string[], home: string) => void;

function readSchedule(path: string): ScheduleFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ScheduleFile;
  } catch {
    return null;
  }
}

// Creates a marker only if it does not exist yet (O_EXCL): the one atomic "I own this fire".
function claimOnce(path: string, body: unknown): boolean {
  try {
    writeFileSync(path, JSON.stringify(body), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Spawns dispatch.ts in its own session with no stdio, so it is never a child of the server. */
export const detachedSpawn: Spawner = (args, home) => {
  const proc = Bun.spawn([process.execPath, dispatchPath(), ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  void proc.exited.catch(() => undefined); // reap the child so it never stays a zombie
  proc.unref();
};

function scheduleIds(home: string): string[] {
  try {
    return readdirSync(join(home, "schedules"));
  } catch {
    return [];
  }
}

function ranSince(sched: ScheduleFile, atMs: number): boolean {
  return (sched.runs ?? []).some((r) => r.started_at !== undefined && Date.parse(r.started_at) >= atMs);
}

/**
 * One evaluation, a pure function of the state under `home` and of `nowMs`.
 * 1. A schedule that is due gets a claim `schedules/<id>/claims/<next_at>` (fire id = id@next_at)
 *    BEFORE anything is spawned; a claim that exists means this fire was already handed over.
 * 2. One `schedule tick` is spawned if any claim was won.
 * 3. Catch-up: the newest claim of a schedule that is past the grace period and has no run is
 *    fired once through `schedule run`, guarded by a `.caughtup` marker.
 */
export function evaluateSchedules(home: string, nowMs: number, spawn: Spawner = detachedSpawn): void {
  let wonClaim = false;
  const catchUps: string[] = [];
  for (const id of scheduleIds(home)) {
    const dir = join(home, "schedules", id);
    const sched = readSchedule(join(dir, "schedule.json"));
    if (sched === null || sched.enabled !== true) {
      continue;
    }
    const claims = join(dir, "claims");
    const next = sched.next_at ?? 0;
    if (next > 0 && next * 1000 <= nowMs) {
      try {
        mkdirSync(claims, { recursive: true });
      } catch {
        continue;
      }
      if (claimOnce(join(claims, String(next)), { fire: `${id}@${next}`, claimed_at: nowMs })) {
        wonClaim = true;
      }
    }
    const newest = newestClaim(claims, nowMs);
    if (newest === null || nowMs - newest.claimedAt < CATCHUP_GRACE_MS || ranSince(sched, newest.at * 1000) || sched.runs?.[0]?.status === "running") {
      continue;
    }
    if (claimOnce(join(claims, `${newest.at}.caughtup`), { fire: `${id}@${newest.at}`, at: nowMs })) {
      catchUps.push(id);
    }
  }
  if (wonClaim) {
    spawn(["schedule", "tick"], home);
  }
  for (const id of catchUps) {
    spawn(["schedule", "run", id], home);
  }
}

function newestClaim(claims: string, nowMs: number): { at: number; claimedAt: number } | null {
  if (!existsSync(claims)) {
    return null;
  }
  let best: { at: number; claimedAt: number } | null = null;
  for (const name of readdirSync(claims)) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const at = Number(name);
    if (nowMs - at * 1000 > CATCHUP_MAX_AGE_MS || (best !== null && at <= best.at)) {
      continue;
    }
    try {
      const body = JSON.parse(readFileSync(join(claims, name), "utf8")) as { claimed_at?: number };
      best = { at, claimedAt: body.claimed_at ?? at * 1000 };
    } catch {
      best = { at, claimedAt: at * 1000 };
    }
  }
  if (best !== null && existsSync(join(claims, `${best.at}.caughtup`))) {
    return null;
  }
  return best;
}

// The server is the scheduler's clock. Each evaluation hands due fires to a detached
// `dispatch.ts schedule tick`, so a restart never kills a tick and never repeats one.
export function startTicker(home: string): Ticker {
  const tick = (): void => {
    try {
      evaluateSchedules(home, Date.now());
    } catch (err) {
      process.stderr.write(`schedule tick error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  const timer = setInterval(tick, TICK_MS);
  return {
    stop: (): void => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
