import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Schedule, ScheduleRun, ScheduleRunStatus } from "../../shared/types/schedule";

const SCHEDULES_DIR: string = "schedules";
const JOBS_DIR: string = "jobs";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function pidAlive(path: string): boolean {
  const pid = Number(readText(path));
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

function isoOf(path: string): string | null {
  try {
    return new Date(Math.floor(statSync(path).mtimeMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
  } catch {
    return null;
  }
}

interface Resolved {
  status: ScheduleRunStatus;
  ended_at: string | null;
  exit: number | null;
}

/** Where a run's result lives: a command run's own folder, or a prompt run's job folder. */
function markers(home: string, run: ScheduleRun): { exit: string; pid: string } {
  if (run.kind === "prompt") {
    const job = join(home, JOBS_DIR, run.ref);
    return { exit: join(job, "exit_code"), pid: join(job, "pid") };
  }
  return { exit: join(run.ref, "exit"), pid: join(run.ref, "pid") };
}

// The same decision `schedule reap` makes in bash, but read-only: a run still recorded as running
// is resolved from its exit marker, so the list is right now without waiting for the next tick to
// write it back (the tick still does, every 30 s).
function resolveRun(home: string, run: ScheduleRun): Resolved {
  const { exit, pid } = markers(home, run);
  const code = readText(exit);
  if (code !== null) {
    const n = Number(code);
    return {
      status: n === 0 ? "ok" : "failed",
      ended_at: isoOf(exit),
      exit: run.kind === "command" && Number.isFinite(n) ? n : null,
    };
  }
  if (pidAlive(pid)) {
    return { status: "running", ended_at: null, exit: null };
  }
  return { status: "lost", ended_at: isoOf(join(exit, "..")) ?? null, exit: null };
}

function withResolvedRuns(home: string, schedule: Schedule): Schedule {
  const runs = schedule.runs.map((run) => {
    if (run.status !== "running") {
      return run;
    }
    const resolved = resolveRun(home, run);
    return resolved.status === "running" ? run : { ...run, ...resolved, ended_at: resolved.ended_at ?? new Date().toISOString().replace(/\.\d+Z$/, "Z") };
  });
  return { ...schedule, runs, last_status: runs[0]?.status ?? null };
}

/**
 * Every schedule, newest first. A direct read of `<home>/schedules/<id>/schedule.json`: the list
 * took 0.2 to 0.8 s through `dispatch.ts schedule list --json`, and the page re-polls every 2 s.
 * Writes still go through `dispatch.ts schedule`, the only writer.
 */
export function readSchedules(home: string): Schedule[] {
  let ids: string[];
  try {
    ids = readdirSync(join(home, SCHEDULES_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: Schedule[] = [];
  for (const id of ids) {
    const text = readText(join(home, SCHEDULES_DIR, id, "schedule.json"));
    if (text === null) {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as Schedule;
      out.push(withResolvedRuns(home, { ...parsed, last_status: parsed.runs[0]?.status ?? null }));
    } catch {
      // A half-written or hand-damaged file must not take the whole list down.
    }
  }
  // Newest first. Two schedules made in the same second tie on created_at, so the id breaks the tie:
  // without it their order could change between polls and the list would jump.
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}
