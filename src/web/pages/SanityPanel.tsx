import { useSyncExternalStore } from "react";
import type { ProfileSanityResult, SanityStatus } from "../../shared/types/profile-sanity";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { useToast } from "../components/Toast";
import { sanity } from "../lib/sanity-store";
import { fmtBytes, fmtMs, STATUS_CHIP, STATUS_LABELS, statusOf, summaryText } from "../lib/sanity-logic";

export function useSanity() {
  return useSyncExternalStore(sanity.subscribe, sanity.get);
}

export function SanityStatusChip({ status }: { status: SanityStatus }) {
  return <Chip status={STATUS_CHIP[status]}>{STATUS_LABELS[status]}</Chip>;
}

/** Runs the probe through the shared store and reports the outcome in a toast. */
export function useRunSanity(): (profiles: string[] | undefined) => void {
  const toast = useToast();
  return (profiles) => {
    void sanity.run(profiles, toast);
  };
}

export function SanityTestButton({ label, profiles }: { label: string; profiles?: string[] }) {
  const state = useSanity();
  const run = useRunSanity();
  return (
    <Button
      disabled={state.running}
      onClick={() => {
        run(profiles);
      }}
    >
      {label}
    </Button>
  );
}

function ResultRow({ result }: { result: ProfileSanityResult }) {
  const model = result.slug !== "" ? result.slug : result.model_id !== "" ? result.model_id : "—";
  return (
    <div className="sanity-row" role="row">
      <div className="sanity-profile">{result.profile}</div>
      <SanityStatusChip status={statusOf(result)} />
      <div className="mono">{result.harness}</div>
      <div className="mono">{model}</div>
      <div className="sanity-ms">{fmtMs(result.ms)}</div>
      <div className="muted">{fmtBytes(result.bytes)}</div>
      <div className="sanity-error muted">{result.error || "—"}</div>
    </div>
  );
}

/** The results table under the profile list; null while nothing was probed. */
export function SanityPanel() {
  const state = useSanity();
  if (state.running) {
    return (
      <div className="sanity-panel" role="status">
        <h2>Sanity test</h2>
        <p className="muted">Running probes… this may take a minute per profile.</p>
      </div>
    );
  }
  if (state.error !== null) {
    return (
      <div className="sanity-panel">
        <h2>Sanity test</h2>
        <div className="notice">{state.error}</div>
      </div>
    );
  }
  if (state.data === null) {
    return null;
  }
  return (
    <div className="sanity-panel">
      <div className="sanity-head">
        <h2>Sanity test</h2>
        <div className="muted">{summaryText(state.data)}</div>
      </div>
      <div className="sanity-list" role="table">
        <div className="sanity-row head" role="row">
          <div>Profile</div>
          <div>Status</div>
          <div>Harness</div>
          <div>Model</div>
          <div>Latency</div>
          <div>Response</div>
          <div>Error</div>
        </div>
        {state.data.results.map((result) => (
          <ResultRow key={result.profile} result={result} />
        ))}
      </div>
    </div>
  );
}
