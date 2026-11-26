import { useState } from "react";
import type { RunLimitHit, RunState } from "../../shared/types/run-state";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { refetchRun } from "./run-actions";

/** One line for the limit that paused the run, with the numbers. */
export function limitText(h: RunLimitHit): string {
  const money = (v: number) => `$${v.toFixed(2)}`;
  switch (h.kind) {
    case "node_usd":
      return `Node ${h.node ?? ""} spent ${money(h.value)} of its ${money(h.limit)} node limit`;
    case "run_usd":
      return `Run spent ${money(h.value)} of its ${money(h.limit)} run limit`;
    case "session_usd":
      return `Session ${h.session ?? ""} spent ${money(h.value)} of its ${money(h.limit)} session limit`;
    case "profile_pct":
      return `Profile ${h.profile ?? ""} is at ${h.value}% usage (limit ${h.limit}%)`;
  }
}

/** Shown while a limit holds the run paused: Resume raises the limit (default double) or ignores it. */
export function RunLimitBanner({ run }: { run: RunState }) {
  const toast = useToast();
  const hit = run.limit_hit ?? null;
  const [draft, setDraft] = useState(hit ? String(Math.max(hit.limit * 2, hit.value + 1)) : "");
  const [busy, setBusy] = useState(false);
  if (!hit || run.paused !== true) {
    return null;
  }
  const value = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(value) && value > hit.value;
  const act = (mode: "raise" | "ignore") => {
    setBusy(true);
    void api.resumeRunLimit(run.run_id, mode, mode === "raise" ? value : undefined).then((result) => {
      setBusy(false);
      if (result.kind === "ok") {
        toast("ok", mode === "raise" ? `Limit raised to ${value}, run resumed` : "Limit ignored, run resumed");
        void refetchRun(run.run_id);
      } else {
        toast("error", describeFailure(result, "Resume failed"));
      }
    });
  };
  return (
    <div className="run-limit-banner" role="status">
      <strong>Paused by a limit.</strong> {limitText(hit)}. Running nodes finish, no new node starts.
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) act("raise");
        }}
      >
        <input type="number" min={0} step="any" value={draft} aria-label="New limit" onChange={(event) => setDraft(event.target.value)} />
        <button className="btn" type="submit" disabled={busy || !valid}>Raise and resume</button>
        <button className="btn" type="button" disabled={busy} onClick={() => act("ignore")}>Ignore and resume</button>
      </form>
    </div>
  );
}
