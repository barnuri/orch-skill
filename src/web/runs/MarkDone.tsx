import { useState } from "react";
import type { RunState } from "../../shared/types/run-state";
import { api } from "../api/client";
import { ReasonDialog } from "./ReasonDialog";

/** "Mark done" for a run: a small popup with an optional message. No check runs and nothing blocks. */
export function MarkDone({ run }: { run: RunState }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" type="button" title="Finish this run by hand" onClick={() => setOpen(true)}>
        Mark done
      </button>
      {open ? (
        <ReasonDialog
          title={`Mark ${run.title || run.run_id} done?`}
          confirmLabel="Confirm"
          reasonRequired={false}
          runId={run.run_id}
          call={(reason) => api.finishRun(run.run_id, reason)}
          done="Run marked done"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
