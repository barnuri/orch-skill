import type { WatchdogStatus } from "../../shared/types/watchdog";
import { watchdogPillState } from "../shell/WatchdogPill";

/** The watchdog's flags and last actions for one run. Renders nothing when the run has neither. */
export function RunWatchdog({ runId, status }: { runId: string; status: WatchdogStatus | null | undefined }) {
  if (status === null || status === undefined) {
    return null;
  }
  const flags = status.flags.filter((flag) => flag.run === runId);
  const actions = status.last_actions.filter((action) => action.run === runId);
  if (flags.length === 0 && actions.length === 0) {
    return null;
  }
  const state = watchdogPillState({ ...status, flags });
  const last = actions[0];
  return (
    <div className={`run-watchdog is-${state}`} role="status" aria-label={`watchdog ${state} for this run`}>
      <span className="run-watchdog-state">watchdog {state}</span>
      {flags.length > 0 ? <span>{flags.length} flagged</span> : null}
      {last ? <span className="muted">last: {last.action}{last.node ? ` on ${last.node}` : ""}</span> : null}
    </div>
  );
}
