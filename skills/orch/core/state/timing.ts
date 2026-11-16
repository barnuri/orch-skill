// Node timing and activity, ported from lib/runs/timing.sh and visibility.sh (run_activity_rows,
// run_stale_nodes). Bun built-ins only. Pure readers: no writes here.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./home.ts";

export const STALE_MINUTES_DEFAULT = 10;

// Mirrors `fromdateiso8601`: only "YYYY-MM-DDTHH:MM:SSZ" parses. Anything else gives null.
export function isoToEpoch(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// Newest mtime (epoch seconds) of the files under the given paths; null when there are none.
export async function newestMtime(paths_: Array<string | null | undefined>): Promise<number | null> {
  let best: number | null = null;
  const walk = async (p: string): Promise<void> => {
    const st = await stat(p).catch(() => null);
    if (!st) return;
    if (st.isFile()) {
      const m = Math.floor(st.mtimeMs / 1000);
      if (best === null || m > best) best = m;
      return;
    }
    if (!st.isDirectory()) return;
    for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
      await walk(join(p, e.name));
    }
  };
  for (const p of paths_) if (p) await walk(p);
  return best;
}

export interface ActivityRow {
  id: string;
  last: number | null; // newest sign of life, epoch seconds
  started: string; // ISO or "-"
  owner: string; // owner, else job id, else "-"
}

// One row per running node, node order. Same rules as run_activity_rows.
export async function activityRows(home: string, runId: string, run: any): Promise<ActivityRow[]> {
  const out: ActivityRow[] = [];
  for (const n of run.nodes ?? []) {
    if (n.status !== "running") continue;
    const upd = isoToEpoch(n.updated);
    const sta = isoToEpoch(n.started);
    const job: string = n.job_id ?? "";
    const dir: string = (n.out_dir ?? "") !== "" ? n.out_dir : paths.runOutDir(home, runId, n.id);
    let last: number | null = null;
    for (const f of [upd, sta]) if (f !== null && (last === null || f > last)) last = f;
    const f = await newestMtime([dir, job ? join(paths.jobs(home), job, "log") : null]);
    if (f !== null && (last === null || f > last)) last = f;
    const owner = n.owner ?? n.job_id ?? "-";
    out.push({
      id: n.id,
      last,
      started: n.started ?? "-",
      owner: String(owner).replace(/[\t\r\n\u001f]/g, " "),
    });
  }
  return out;
}

// Ids of running nodes with no activity for `minutes`. Same as run_stale_nodes.
export function staleNodes(rows: ActivityRow[], minutes: number, now: number): string[] {
  return rows
    .filter((r) => r.last !== null && now - r.last >= minutes * 60)
    .map((r) => r.id);
}

// settings.stale_minutes from profiles.json, when a positive integer; else the default.
export async function staleMinutes(home: string): Promise<number> {
  const raw = await Bun.file(paths.profiles(home))
    .json()
    .then((p: any) => p?.settings?.stale_minutes)
    .catch(() => undefined);
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw) && Number(raw) >= 1) return Number(raw);
  return STALE_MINUTES_DEFAULT;
}
