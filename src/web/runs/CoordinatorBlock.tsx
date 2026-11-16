import { useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toast";
import type { CoordinatorState } from "../../server/runs/coordinator-state";
import { refetchRun } from "./run-actions";

/** Coordinator state of a run: amber when unreachable (red is for errors only), with a pick list of candidates. */
export function CoordinatorBlock({ runId, state }: { runId: string; state: CoordinatorState | null | undefined }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (state === null || state === undefined) {
    return null;
  }
  const pick = (socket: string, pane: string): void => {
    void api.repointRun(runId, socket, pane).then((result) => {
      if (result.kind === "ok") {
        toast("ok", "Coordinator chosen");
        setOpen(false);
        void refetchRun(runId);
      } else {
        toast("error", "Could not choose that pane");
      }
    });
  };
  const pending = state.pending_asks === 1 ? "1 pending node question" : `${state.pending_asks} pending node questions`;
  return (
    <div className={`coordinator-block ${state.reachable ? "coordinator-ok" : "coordinator-unreachable"}`} data-reachable={state.reachable}>
      <span className="chip">coordinator {state.pane_id}</span>
      {state.reachable ? (
        <span className="muted">reachable</span>
      ) : (
        <span className="coordinator-warn">unreachable since {state.unreachable_since}: {state.unreachable_reason}</span>
      )}
      <span className="muted">{pending}</span>
      {state.last_repoint === null ? null : (
        <span className="muted">last repoint {state.last_repoint.at} ({state.last_repoint.reason})</span>
      )}
      {state.reachable ? null : (
        <button type="button" className="btn" onClick={() => setOpen(!open)}>
          Choose coordinator
        </button>
      )}
      {open ? (
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
