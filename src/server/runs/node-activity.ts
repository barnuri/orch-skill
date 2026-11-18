import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunState } from "../../shared/types/run-state";
import type { OrchPaths } from "../types/orch-paths";

export const STALE_MINUTES_DEFAULT: number = 10;
const MS_PER_MINUTE: number = 60_000;
const MAX_FILES: number = 500;

export function staleMinutes(paths: OrchPaths): number {
  try {
    const value: unknown = (JSON.parse(readFileSync(paths.profiles, "utf8")) as { settings?: { stale_minutes?: unknown } })
      .settings?.stale_minutes;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : STALE_MINUTES_DEFAULT;
  } catch {
    return STALE_MINUTES_DEFAULT;
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function newestInDir(dir: string): number | null {
  let best: number | null = null;
  let names: string[];
  try {
    names = readdirSync(dir).slice(0, MAX_FILES);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = mtimeMs(join(dir, name));
    if (m !== null && (best === null || m > best)) {
      best = m;
    }
  }
  return best;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function outDirOf(paths: OrchPaths, run: RunState, node: RunState["nodes"][number]): string {
  const outDir = (node as { out_dir?: unknown }).out_dir;
  return typeof outDir === "string" && outDir !== "" ? outDir : join(paths.runs, run.run_id, "out", node.id);
}

/** True when the node's out dir holds a non-empty handoff.md. */
function handoffPresent(dir: string): boolean {
  try {
    return statSync(join(dir, "handoff.md")).size > 0;
  } catch {
    return false;
  }
}

/**
 * Newest of: node `updated`, `started`, its out dir files, its job log. Sets `last_activity` and
 * `stale` on every running node, in place. Sets `handoff_present` on every node. Other fields are left untouched.
 */
export function annotateActivity(paths: OrchPaths, run: RunState, nowMs: number = Date.now()): void {
  const limit = staleMinutes(paths) * MS_PER_MINUTE;
  for (const node of run.nodes) {
    if (node === undefined || node === null) {
      continue;
    }
    const dir = outDirOf(paths, run, node);
    node.handoff_present = handoffPresent(dir);
    if (node.status !== "running") {
      continue;
    }
    const candidates = [
      isoMs(node.updated),
      isoMs(node.started),
      newestInDir(dir),
      node.job_id ? mtimeMs(join(paths.jobs, node.job_id, "log")) : null,
    ].filter((v): v is number => v !== null);
    if (candidates.length === 0) {
      continue;
    }
    const last = Math.max(...candidates);
    node.last_activity = new Date(last).toISOString();
    node.stale = nowMs - last >= limit;
  }
}
