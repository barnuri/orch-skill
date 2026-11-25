// Runs started before 2026-11-25 carry a `done-gate` node. The orchestrator now closes a run itself (`run verify`,
// then `run finish`), so a gate node that never ran is read as skipped. Pure: returns the same object, edited in place.

export const LEGACY_GATE_ID = "done-gate";
export const LEGACY_GATE_REASON = "replaced by the orchestrator's verify and finish";
const UNRUN = new Set(["waiting", "ready", "running", "blocked-user", "error", "stopped"]);

export function retireLegacyGate<T extends { nodes?: unknown }>(run: T): T {
  if (!Array.isArray(run.nodes)) return run;
  for (const n of run.nodes as Array<Record<string, any>>) {
    if (n?.id === LEGACY_GATE_ID && UNRUN.has(String(n.status))) {
      n.status = "skipped";
      n.skip_reason = LEGACY_GATE_REASON;
      n.needs_user = null;
      n.error = null;
      n.rerun = false;
    }
  }
  return run;
}
