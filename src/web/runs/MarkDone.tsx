import { useEffect, useState } from "react";
import type { RunState } from "../../shared/types/run-state";
import { api, type RunVerifyEnvelope } from "../api/client";
import { ReasonDialog } from "./ReasonDialog";

/** "Mark done" for a run: shows what `run verify` still reports, asks for a reason when it fails, then finishes by hand. */
export function MarkDone({ run }: { run: RunState }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" type="button" title="Finish this run by hand" onClick={() => setOpen(true)}>
        Mark done
      </button>
      {open ? <MarkDoneDialog run={run} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function MarkDoneDialog({ run, onClose }: { run: RunState; onClose: () => void }) {
  const [verify, setVerify] = useState<RunVerifyEnvelope | "error" | null>(null);
  useEffect(() => {
    let live = true;
    void api.verifyRun(run.run_id).then((result) => {
      if (live) {
        setVerify(result.kind === "ok" ? result.body : "error");
      }
    });
    return () => {
      live = false;
    };
  }, [run.run_id]);
  const failures = verify !== null && verify !== "error" && !verify.ok ? verify.failures : [];
  const intro =
    verify === null ? "Checking the run…" : verify === "error" ? "Could not run the check. The server decides when you confirm." : failures.length === 0 ? "The run passes verify. It finishes normally." : `${failures.length} verify failure(s). Finishing skips the done-gate with your reason.`;
  return (
    <ReasonDialog
      title={`Mark ${run.title || run.run_id} done?`}
      intro={intro}
      confirmLabel="Confirm"
      reasonRequired={failures.length > 0 || verify === "error"}
      loading={verify === null}
      runId={run.run_id}
      call={(reason) => api.finishRun(run.run_id, reason)}
      done="Run marked done"
      onClose={onClose}
    >
      {failures.length === 0 ? null : (
        <ul className="reason-failures" aria-label="Verify failures">
          {failures.map((failure, index) => (
            <li key={index}>
              {failure.nodes.length === 0 ? "" : <b>{failure.nodes.join(", ")}: </b>}
              {failure.msg}
            </li>
          ))}
        </ul>
      )}
    </ReasonDialog>
  );
}
