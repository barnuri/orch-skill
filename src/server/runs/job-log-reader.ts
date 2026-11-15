import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { OrchPaths } from "../types/orch-paths";
import { isRunId } from "./run-id";

/** A whole log would be unbounded; a run that logs a binary blob must not take the server down. */
export const MAX_LOG_BYTES: number = 2 * 1024 * 1024;

export type JobLogResult =
  | { kind: "ok"; text: string; truncated: boolean; bytes: number }
  | { kind: "missing" }
  | { kind: "invalid" };

/**
 * The full log a job wrote, not the 20-line tail `run sync` copies into state.json.
 *
 * Job ids share the run-id alphabet, so the same guard applies: it can never name a dotfile,
 * `..`, or anything with a path separator. Over the cap the **tail** is kept — for a transcript
 * the end is the part you came for.
 */
export function readJobLog(paths: OrchPaths, jobId: string): JobLogResult {
  if (!isRunId(jobId)) {
    return { kind: "invalid" };
  }
  const file = join(paths.jobs, jobId, "log");
  let bytes: number;
  try {
    bytes = statSync(file).size;
  } catch {
    return { kind: "missing" };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { kind: "missing" };
  }
  if (bytes <= MAX_LOG_BYTES) {
    return { kind: "ok", text, truncated: false, bytes };
  }
  return { kind: "ok", text: text.slice(-MAX_LOG_BYTES), truncated: true, bytes };
}

/** The session id orch assigned this job at dispatch, when it recorded one. */
export function readJobSession(paths: OrchPaths, jobId: string): string | null {
  if (!isRunId(jobId)) {
    return null;
  }
  try {
    const session = readFileSync(join(paths.jobs, jobId, "session"), "utf8").trim();
    return session === "" ? null : session;
  } catch {
    return null;
  }
}
