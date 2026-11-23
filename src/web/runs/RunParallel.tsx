import { useEffect, useState } from "react";
import type { RunState } from "../../shared/types/run-state";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { refetchRun } from "./run-actions";

/** The per-run cap the input accepts: -1 (unlimited) or an integer 1-30. */
export function parseParallel(text: string): number | null {
  if (!/^-?\d+$/.test(text.trim())) {
    return null;
  }
  const value = Number(text.trim());
  return value === -1 || (value >= 1 && value <= 30) ? value : null;
}

/** Per-run parallel cap. The effective cap is min(global, this); -1 is still bounded by the global cap. */
export function RunParallel({ run }: { run: RunState }) {
  const toast = useToast();
  const current = run.max_parallel ?? null;
  const shown = current === null ? "" : String(current);
  const [draft, setDraft] = useState(shown);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(shown);
  }, [shown]);
  const next = parseParallel(draft);
  const apply = (): void => {
    if (next === null) {
      return;
    }
    setBusy(true);
    void api.setRunMaxParallel(run.run_id, next).then((result) => {
      setBusy(false);
      if (result.kind === "ok") {
        toast("ok", `Parallel cap set to ${next === -1 ? "unlimited" : next}`);
        void refetchRun(run.run_id);
      } else {
        toast("error", describeFailure(result, "Parallel cap failed"));
      }
    });
  };
  return (
    <form
      className="run-parallel"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <label>
        <span className="run-stat-key">parallel</span>
        <input
          type="number"
          min={-1}
          max={30}
          step={1}
          value={draft}
          placeholder="global"
          aria-label="Run parallel cap"
          aria-invalid={draft !== "" && next === null}
          title="Per-run cap: 1-30, or -1 for unlimited. The global cap still applies."
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button className="btn" type="submit" disabled={busy || next === null || String(next) === shown}>
        Set parallel
      </button>
    </form>
  );
}
