// Finished-but-alive nodes: the node recorded its result (or wrote its handoff) but its job process still lives and
// its log stopped growing. Typical cause: the agent started a background shell job (`--watch`), and the harness does
// not exit while that job lives. Detection only reads files; `run sync` records it and `node reap` ends it.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../state/home.ts";
import { jobStatus } from "../state/proc.ts";
import { epochOf } from "../state/clock.ts";
import { settingFrom } from "../state/settings.ts";

/** Minutes without log growth before a finished-but-alive node is reported. */
export const STUCK_AFTER_RESULT_DEFAULT_MIN = 5;

export interface StuckAfterResult {
  node: string;
  job: string;
  idleMin: number;
  /** "result" when `node result` was recorded for this attempt, else "handoff". */
  evidence: "result" | "handoff";
  verdict: string;
}

type Doc = Parameters<typeof settingFrom>[0];

function minutesSetting(doc: Doc, key: string, dflt: number): number {
  const v = settingFrom(doc, key, String(dflt));
  return /^[0-9]+$/.test(v) ? Number(v) : dflt;
}

/** settings.stuck_after_result_min: idle minutes before the report (default 5, 0 = off). */
export const stuckAfterResultMinutes = (doc: Doc): number => minutesSetting(doc, "stuck_after_result_min", STUCK_AFTER_RESULT_DEFAULT_MIN);

/** settings.reap_after_result_min: idle minutes before `run sync` reaps the node by itself (default 0 = off, report only). */
export const reapAfterResultMinutes = (doc: Doc): number => minutesSetting(doc, "reap_after_result_min", 0);

function attemptStartMs(n: Record<string, any>): number | null {
  const t = epochOf(String(n.dispatched_at ?? n.started_at ?? n.started ?? ""));
  return t === null ? null : t * 1000;
}

function ownHandoffMs(home: string, runId: string, n: Record<string, any>): number | null {
  const dir = typeof n.out_dir === "string" && n.out_dir !== "" ? n.out_dir : paths.runOutDir(home, runId, String(n.id));
  const file = join(dir, "handoff.md");
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    if (text.trim() === "" || text.startsWith("# Generated handoff")) return null;
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function logMtimeMs(jobDir: string): number | null {
  for (const f of ["log.plain", "log"]) {
    try {
      return statSync(join(jobDir, f)).mtimeMs;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The finished-but-alive evidence of one node, or null. `minutes` 0 turns detection off. */
export function stuckAfterResultOf(home: string, runId: string, n: Record<string, any>, nowMs: number, minutes: number): StuckAfterResult | null {
  if (minutes <= 0 || n.status !== "running" || !n.job_id) return null;
  const job = String(n.job_id);
  const start = attemptStartMs(n) ?? 0;
  const resultAt = typeof n.result?.verdict === "string" && n.result.verdict !== "unknown" ? epochOf(String(n.result.at ?? "")) : null;
  const hasResult = resultAt !== null && resultAt * 1000 >= start - 1000;
  const handoffMs = hasResult ? null : ownHandoffMs(home, runId, n);
  if (!hasResult && (handoffMs === null || handoffMs < start)) return null;
  const jobDir = join(paths.jobs(home), job);
  if (jobStatus(paths.jobs(home), job) !== "running") return null;
  const logMs = logMtimeMs(jobDir);
  const finishedMs = hasResult ? resultAt! * 1000 : handoffMs!;
  // The log is the activity signal ("has not grown for N minutes"); the finish time only stands in when there is no log.
  const lastMs = logMs ?? finishedMs;
  const idleMin = Math.floor((nowMs - lastMs) / 60_000);
  if (idleMin < minutes) return null;
  return { node: String(n.id), job, idleMin, evidence: hasResult ? "result" : "handoff", verdict: hasResult ? String(n.result.verdict) : "" };
}

/** Every finished-but-alive node of a run. */
export function findStuckAfterResult(home: string, runId: string, run: { nodes: Array<Record<string, any>> }, nowMs: number, minutes: number): StuckAfterResult[] {
  return run.nodes.map((n) => stuckAfterResultOf(home, runId, n, nowMs, minutes)).filter((x): x is StuckAfterResult => x !== null);
}

export const reapCommand = (runId: string, node: string): string => `dispatch.ts node reap ${runId} ${node}`;
