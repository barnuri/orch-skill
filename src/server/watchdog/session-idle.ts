// Whether a registered orchestrator session is idle: no activity for settings.orchestrator_idle_minutes and no live
// TUI process holds it. Evidence: opencode.db session_v2.time_updated, the announce activity file, process args
// (-s/--session <id>, or the id anywhere in the args). A session with no evidence at all counts as idle.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

export const ORCHESTRATOR_IDLE_MINUTES_DEFAULT = 30;

export function orchestratorIdleMinutes(home: string): number {
  try {
    const v = (JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")) as { settings?: Record<string, unknown> }).settings?.["orchestrator_idle_minutes"];
    const n = Number(v);
    return v !== undefined && v !== null && Number.isFinite(n) && n >= 1 ? n : ORCHESTRATOR_IDLE_MINUTES_DEFAULT;
  } catch {
    return ORCHESTRATOR_IDLE_MINUTES_DEFAULT;
  }
}

export interface IdleSeams {
  now: () => Date;
  /** opencode db path; default ~/.local/share/opencode/opencode.db (ORCH_OPENCODE_DB overrides). */
  dbPath?: string;
  /** Command lines of the running processes; default `ps -axo args=`. */
  processArgs?: () => string[];
}

function dbUpdatedMs(path: string, sid: string): number | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query("select time_updated from session_v2 where id = ?").get(sid) as { time_updated?: number } | null;
      return typeof row?.time_updated === "number" ? row.time_updated : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function defaultProcessArgs(): string[] {
  const r = Bun.spawnSync(["ps", "-axo", "args="], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().split("\n");
}

export function holdsSession(lines: string[], sid: string): boolean {
  return lines.some((l) => l.includes(sid) && !l.includes("job-run") && /\b(opencode|claude|codex|pi)\b/.test(l));
}

export function makeSessionIdle(home: string, seams: IdleSeams): (sid: string) => boolean {
  const procArgs = seams.processArgs ?? defaultProcessArgs;
  let cache: { at: number; lines: string[] } | null = null;
  return (sid: string): boolean => {
    const nowMs = seams.now().getTime();
    const limit = orchestratorIdleMinutes(home) * 60_000;
    let last: number | null = null;
    try { last = statSync(join(home, "activity", `${sid}.json`)).mtimeMs; } catch { /* none */ }
    const db = dbUpdatedMs(seams.dbPath ?? process.env["ORCH_OPENCODE_DB"] ?? join(homedir(), ".local/share/opencode/opencode.db"), sid);
    if (db !== null && (last === null || db > last)) last = db;
    if (last !== null && nowMs - last < limit) return false;
    if (cache === null || nowMs - cache.at > 30_000) cache = { at: nowMs, lines: procArgs() };
    return !holdsSession(cache.lines, sid);
  };
}
