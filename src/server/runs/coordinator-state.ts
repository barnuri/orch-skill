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

/**
 * An open orchestrator question: a kind=ask with no answer yet whose node did not time out (a late ask is
 * activity only). kind=tell messages (watchdog, nodes) never count.
 */
export function isOpenOrchestratorQuestion(msg: Record<string, unknown>): boolean {
  const answered = typeof msg.answer === "string" ? msg.answer !== "" : msg.answer !== null && msg.answer !== undefined;
  return msg.kind === "ask" && !answered && (msg.answered_at ?? null) === null && msg.answered_late_expected !== true;
}

/** Open orchestrator questions of a run (inbox/orch). */
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
    if (msg !== null && isOpenOrchestratorQuestion(msg)) {
      n += 1;
    }
  }
  return n;
}

/** The orchestrator block of a run for the API and run page; null when the run has no orchestrator. */
export function orchestratorState(runsDir: string, run: Record<string, unknown>): CoordinatorState | null {
  const coord = run.orchestrator ?? run.coordinator;
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

export const coordinatorState = orchestratorState;
