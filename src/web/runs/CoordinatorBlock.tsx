import { useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toast";
import type { CoordinatorState } from "../../shared/types/coordinator";
import { refetchRun } from "./run-actions";

/**
 * Orchestrator block of a run. It shows only when an orchestrator question is open or the orchestrator is
 * unreachable; routine tells do not activate it. "Choose orchestrator" needs an open question and an unreachable
 * orchestrator. Red is for errors only.
 */
export function CoordinatorBlock({ runId, state }: { runId: string; state: CoordinatorState | null | undefined }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (state === null || state === undefined) {
    return null;
  }
  if (state.reachable && state.pending_asks === 0) {
    return null;
  }
  const canChoose = !state.reachable && state.pending_asks > 0;
  const pick = (socket: string, pane: string): void => {
    void api.repointRun(runId, socket, pane).then((result) => {
      if (result.kind === "ok") {
        toast("ok", "Orchestrator chosen");
        setOpen(false);
        void refetchRun(runId);
      } else {
        toast("error", "Could not choose that pane");
      }
    });
  };
  const pending = state.pending_asks === 1 ? "1 pending orchestrator question" : `${state.pending_asks} pending orchestrator questions`;
  return (
    <div className={`coordinator-block ${state.reachable ? "coordinator-ok" : "coordinator-unreachable"}`} data-reachable={state.reachable}>
      <span className="chip">orchestrator {state.transport === "hc" ? "hc " : ""}{state.pane_id}</span>
      {state.reachable ? (
        <span className="muted">reachable</span>
      ) : (
        <span className="coordinator-warn">unreachable since {state.unreachable_since}: {state.unreachable_reason}</span>
      )}
      {state.pending_asks > 0 ? <span className="muted">{pending}</span> : null}
      {state.last_repoint === null ? null : (
        <span className="muted">last repoint {state.last_repoint.at} ({state.last_repoint.reason})</span>
      )}
      {canChoose ? (
        <button type="button" className="btn" onClick={() => setOpen(!open)}>
          Choose orchestrator
        </button>
      ) : null}
      {open && canChoose ? (
        <ul className="coordinator-candidates">
          {state.candidates.length === 0 ? <li className="muted">no candidate panes found</li> : null}
          {state.candidates.map((c) => (
            <li key={`${c.socket_path}/${c.pane_id}`}>
              <button type="button" className="btn" onClick={() => pick(c.socket_path, c.pane_id)}>
                {c.pane_id} · {c.agent} · {c.cwd}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
