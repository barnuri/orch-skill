import type { WatchdogRule, WatchdogStatus, WatchdogFlag } from "../../shared/types/watchdog";
import type { SupervisorFlag } from "../../../skills/orch/core/runs/projection";
import { watchdogPillState } from "../shell/WatchdogPill";

/** The watchdog's last actions for one run, and the flags the projection reports for it. Renders nothing when the run has neither. */
export function RunWatchdog({ runId, status, flags }: { runId: string; status: WatchdogStatus | null | undefined; flags: readonly SupervisorFlag[] }) {
  if (status === null || status === undefined) {
    return null;
  }
  const actions = status.last_actions.filter((action) => action.run === runId);
  if (flags.length === 0 && actions.length === 0) {
    return null;
  }
  const runFlags: WatchdogFlag[] = flags.map((f) => ({ run: runId, node: f.node, rule: f.rule as WatchdogRule, detail: f.detail, at: f.at }));
  const state = watchdogPillState({ ...status, flags: runFlags });
  const last = actions[0];
  return (
    <div className={`run-watchdog is-${state}`} role="status" aria-label={`watchdog ${state} for this run`}>
      <span className="run-watchdog-state">watchdog {state}</span>
      {flags.length > 0 ? <span>{flags.length} flagged</span> : null}
      {last ? <span className="muted">last: {last.action}{last.node ? ` on ${last.node}` : ""}</span> : null}
    </div>
  );
}
