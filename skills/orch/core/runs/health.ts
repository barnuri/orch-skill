// Node health classification, shared by `run wait` and `run health`. Port of HEALTH_JQ (lib/runs/health.sh),
// the running-node part: health of every running node from the run state and opencode's session index.
import { isoToEpoch } from "../state/timing.ts";
import { loadProfilesDoc, settingFrom } from "../state/settings.ts";
import { sessionIndex, type Sess } from "../commands/owners.ts";

export const HEALTH_STALL_MIN_DEFAULT = 15;
export const HEALTH_EVERY_SEC_DEFAULT = 30;
export const HEALTH_EVERY_SEC_MIN = 10;
export const HEALTH_NUDGE_GAP_SECS = 1800;
export const HEALTH_INDEX_DAYS = 3;

export interface NodeHealth {
  id: string;
  health: "ok" | "stalled" | "dead" | "unowned" | "no-report";
  note: string | null;
  last: number | null;
}

const uint = (v: string) => /^[0-9]+$/.test(v);

export async function healthEverySec(home: string): Promise<number> {
  let v = process.env.ORCH_HEALTH_EVERY_SEC || settingFrom(await loadProfilesDoc(home), "health_every_sec", String(HEALTH_EVERY_SEC_DEFAULT));
  if (!uint(v)) v = String(HEALTH_EVERY_SEC_DEFAULT);
  return Math.max(Number(v), HEALTH_EVERY_SEC_MIN);
}

export async function stallMinutes(home: string): Promise<number> {
  const v = process.env.ORCH_STALL_MIN || settingFrom(await loadProfilesDoc(home), "stall_minutes", String(HEALTH_STALL_MIN_DEFAULT));
  return uint(v) ? Number(v) : HEALTH_STALL_MIN_DEFAULT;
}

// jq `ep`: ISO with optional fraction -> epoch seconds, null when empty or unparsable.
function ep(s: unknown): number | null {
  if (typeof s !== "string" || s === "") return null;
  return isoToEpoch(s.replace(/\.[0-9]+Z$/, "Z"));
}

function hhmm(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const maxOf = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};

export function classifyRunning(run: any, index: Sess[], now: number, stallSecs: number, days = HEALTH_INDEX_DAYS): NodeHealth[] {
  const S = new Map(index.map((s) => [s.id, s]));
  const out: NodeHealth[] = [];
  for (const n of run.nodes ?? []) {
    if (n.status !== "running") continue;
    const s = n.owner_kind === "session" && (n.owner_id ?? "") !== "" ? S.get(n.owner_id) ?? null : null;
    const noteat = maxOf((n.notes ?? []).map((x: any) => ep(x?.at)));
    const last = s
      ? maxOf([s.updated, noteat, ep(n.last_activity)])
      : maxOf([ep(n.updated), ep(n.started), ep(n.last_activity), noteat]);
    let h: NodeHealth["health"];
    if ((n.owner ?? "") === "" && (n.job_id ?? "") === "") h = "unowned";
    else if (n.owner_kind === "session" && (n.owner_id ?? "") !== "" && s === null && index.length > 0 && (ep(n.started) ?? 0) > now - days * 86400) h = "dead";
    else if (last !== null && now - last >= stallSecs) h = "stalled";
    else if (s !== null && !s.busy && (n.report == null || n.report.reported_by === "owner-fill")) h = "no-report";
    else h = "ok";
    const note =
      h === "stalled" ? `no activity since ${hhmm(last!)}`
      : h === "dead" ? `session ${n.owner_id} is gone`
      : h === "unowned" ? "running with no owner and no job"
      : h === "no-report" ? "session idle, node not reported"
      : null;
    out.push({ id: n.id, health: h, note, last });
  }
  return out;
}

export async function healthMap(home: string, run: any, stallMin: number): Promise<Record<string, { h: string; note: string | null }>> {
  const now = Math.floor(Date.now() / 1000);
  const m: Record<string, { h: string; note: string | null }> = {};
  for (const x of classifyRunning(run, sessionIndex(), now, stallMin * 60)) m[x.id] = { h: x.health, note: x.note };
  return m;
}
