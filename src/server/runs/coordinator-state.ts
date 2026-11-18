import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CoordinatorCandidate, CoordinatorState } from "../../shared/types/coordinator";

export type { CoordinatorCandidate, CoordinatorState };

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Asks to the coordinator (inbox/orch) that have no delivered_at yet. */
export function countPendingAsks(runsDir: string, runId: string): number {
  const dir = join(runsDir, runId, "inbox", "orch");
  if (!existsSync(dir)) {
    return 0;
  }
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const msg = readJson(join(dir, name));
    if (msg !== null && msg.kind === "ask" && (msg.delivered_at ?? null) === null) {
      n += 1;
    }
  }
  return n;
}

/** The coordinator block of a run for the API and run page; null when the run has no coordinator. */
export function coordinatorState(runsDir: string, run: Record<string, unknown>): CoordinatorState | null {
  const coord = run.coordinator;
  if (typeof coord !== "object" || coord === null) {
    return null;
  }
  const c = coord as Record<string, unknown>;
  const un = typeof c.unreachable === "object" && c.unreachable !== null ? (c.unreachable as Record<string, unknown>) : null;
  const rp = typeof c.last_repoint === "object" && c.last_repoint !== null ? (c.last_repoint as CoordinatorState["last_repoint"]) : null;
  return {
    transport: c.transport === "hc" || c.socket_path === "hc" ? "hc" : "herdr",
    pane_id: String(c.pane_id ?? ""),
    reachable: un === null,
    unreachable_since: un === null ? null : String(un.at ?? ""),
    unreachable_reason: un === null ? null : String(un.reason ?? ""),
    pending_asks: countPendingAsks(runsDir, String(run.run_id ?? "")),
    last_repoint: rp,
    candidates: Array.isArray(c.candidates) ? (c.candidates as CoordinatorCandidate[]) : [],
  };
}
