import type { RunState } from "../../shared/types/run-state";
import type { LiveState } from "./queries";
import { filterOptions, isFilterActive, EMPTY_FILTER, SUMMARY_BUCKETS, VERDICTS, type NodeFilter, type RunSummary, type SummaryBucket } from "./run-filter";

const LIVE_TEXT: Readonly<Record<LiveState, { text: string; title: string }>> = {
  live: { text: "live", title: "Live: the run stream is open and the page updates by itself" },
  connecting: { text: "connecting", title: "Connecting to the run stream" },
  offline: { text: "offline", title: "Offline: the run stream dropped. The page polls every 5 s and reconnects by itself" },
};

export function LiveIndicator({ state }: { state: LiveState }) {
  const label = LIVE_TEXT[state];
  return (
    <span className={`run-live is-${state}`} role="status" title={label.title} aria-label={label.title}>
      <span className="run-live-dot" aria-hidden="true" />
      {label.text}
    </span>
  );
}

/** Total plus one count per bucket. Clicking a count filters the graph to it; clicking it again clears it. */
export function RunSummaryBar({ summary, active, onPick }: { summary: RunSummary; active: SummaryBucket | ""; onPick: (bucket: SummaryBucket | "") => void }) {
  return (
    <div className="run-summary" role="group" aria-label="Node counts">
      <button type="button" className={`run-summary-item is-total${active === "" ? " is-on" : ""}`} onClick={() => onPick("")} title="Show all nodes">
        <span className="run-summary-key">total</span>
        <b>{summary.total}</b>
      </button>
      {SUMMARY_BUCKETS.map((bucket) =>
        bucket === "skipped" && summary.skipped === 0 ? null : (
          <button
            key={bucket}
            type="button"
            className={`run-summary-item is-${bucket}${active === bucket ? " is-on" : ""}${summary[bucket] === 0 ? " is-zero" : ""}`}
            aria-pressed={active === bucket}
            title={`Show only ${bucket} nodes`}
            onClick={() => onPick(active === bucket ? "" : bucket)}
          >
            <span className="run-summary-key">{bucket}</span>
            <b>{summary[bucket]}</b>
          </button>
        ),
      )}
    </div>
  );
}

interface FilterProps {
  run: RunState;
  filter: NodeFilter;
  harnessByProfile: Readonly<Record<string, string>>;
  shown: number;
  onChange: (next: NodeFilter) => void;
}

export function NodeFilterBar({ run, filter, harnessByProfile, shown, onChange }: FilterProps) {
  const options = filterOptions(run, harnessByProfile);
  const active = isFilterActive(filter);
  return (
    <div className="run-filter" role="search">
      <input
        className="input run-filter-q"
        type="search"
        placeholder="Search nodes by label or id"
        aria-label="Search nodes by label or id"
        value={filter.q}
        onChange={(event) => onChange({ ...filter, q: event.target.value })}
      />
      <select className="input" aria-label="Filter by status" value={filter.status} onChange={(event) => onChange({ ...filter, status: event.target.value as SummaryBucket | "" })}>
        <option value="">any status</option>
        {SUMMARY_BUCKETS.map((bucket) => (
          <option key={bucket} value={bucket}>
            {bucket}
          </option>
        ))}
      </select>
      <select className="input" aria-label="Filter by profile or harness" value={filter.profile} onChange={(event) => onChange({ ...filter, profile: event.target.value })}>
        <option value="">any profile / harness</option>
        {options.profiles.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select className="input" aria-label="Filter by model" value={filter.model} onChange={(event) => onChange({ ...filter, model: event.target.value })}>
        <option value="">any model</option>
        {options.models.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select className="input" aria-label="Filter by result verdict" value={filter.verdict} onChange={(event) => onChange({ ...filter, verdict: event.target.value as NodeFilter["verdict"] })}>
        <option value="">any verdict</option>
        {VERDICTS.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {active ? (
        <>
          <span className="muted run-filter-count">{`${shown} of ${run.nodes.length} nodes`}</span>
          <button className="btn" type="button" onClick={() => onChange(EMPTY_FILTER)}>
            Clear
          </button>
        </>
      ) : null}
    </div>
  );
}
