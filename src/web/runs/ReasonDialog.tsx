import "./runs.css";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../components/Button";
import type { ApiResult } from "../api/result";
import { describeFailure } from "../api/result";
import { useToastOptional } from "../components/Toast";
import { refetchRun } from "./run-actions";

export interface ReasonDialogProps {
  title: string;
  /** One short line under the title. */
  intro?: string;
  confirmLabel: string;
  /** False: the reason may stay empty (a run whose verify passes). */
  reasonRequired: boolean;
  /** Extra content between the intro and the reason field, e.g. the verify failures. */
  children?: ReactNode;
  /** Hold Confirm until true (the verify call is still running). */
  loading?: boolean;
  runId: string;
  call: (reason: string) => Promise<ApiResult<unknown>>;
  done: string;
  onClose: () => void;
}

/** A small modal: optional detail, a reason field, Cancel and Confirm. Used to finish a run or a node by hand. */
export function ReasonDialog({ title, intro, confirmLabel, reasonRequired, children, loading = false, runId, call, done, onClose }: ReasonDialogProps) {
  const toast = useToastOptional();
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    if (node !== null && !node.open) {
      node.showModal();
    }
  }, []);
  const missing = reasonRequired && reason.trim() === "";
  const confirm = (): void => {
    if (missing || busy || loading) {
      return;
    }
    setBusy(true);
    setError("");
    void call(reason.trim()).then((result) => {
      setBusy(false);
      if (result.kind === "ok") {
        toast("ok", done);
        void refetchRun(runId);
        dialog.current?.close();
      } else {
        setError(describeFailure(result as never, "Failed"));
      }
    });
  };
  return (
    <dialog ref={dialog} className="confirm reason-dialog" aria-labelledby={`${id}-t`} onClose={onClose} onClick={(event) => event.stopPropagation()}>
      <h2 id={`${id}-t`}>{title}</h2>
      {intro === undefined ? null : <p>{intro}</p>}
      {children}
      <label className="reason-field">
        <span>{reasonRequired ? "Reason (required)" : "Reason (optional)"}</span>
        <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} aria-required={reasonRequired} placeholder={reasonRequired ? "Why is this done?" : "Optional message"} />
      </label>
      {error === "" ? null : (
        <p className="reason-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <Button
          onClick={() => {
            dialog.current?.close();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" disabled={missing || busy || loading} onClick={confirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
