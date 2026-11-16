import "./runs.css";
import { useState } from "react";
import type { ActiveItem } from "../../shared/types/active-item";
import type { NodeStatus } from "../../shared/types/node-status";
import { RUN_STATUSES } from "../../shared/types/run-status";
import type { RunSummary } from "../../shared/types/run-summary";
import { useActive } from "../api/queries";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { PageHead } from "../components/PageHead";
import { Labelled, Segmented } from "../components/Segmented";
import { Skeleton } from "../components/Skeleton";
import { STATUS_ORDER } from "../lib/constants";
import { fmtDur, rel, until } from "../lib/format";
import { summaryUsageMetric } from "../lib/node-metrics";
import {
  AGE_LABELS,
  ALL_STATUSES,
  DEFAULT_RUN_FILTERS,
  RUN_AGE_VALUES,
  SHOW_ALL_RUN_FILTERS,
  loadRunFilters,
  matchesRunFilters,
  runFiltersActive,
  saveRunFilters,
} from "../lib/run-filters";
import type { RunFilters } from "../lib/run-filters";
import { ActiveStrip } from "./ActiveStrip";
import { useRuns, useRunsHealth } from "./queries";
import { RunHealthSummary } from "./RunHealth";
import type { RunHealth } from "../../shared/types/run-health";
import { useNow } from "./use-now";

type Counts = Record<NodeStatus, number>;

const totalOf = (counts: Counts): number => STATUS_ORDER.reduce((sum, status) => sum + counts[status], 0);

function StatusBar({ counts, total }: { counts: Counts; total: number }) {
  return (
    <div className="bar" title={`${total} nodes`}>
      {STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => (
        <span key={status} className={status} style={{ width: `${(100 * counts[status]) / total}%` }} />
      ))}
    </div>
  );
}

/** Duration, usage and nodes done, always all three: a missing one reads as a muted placeholder. */
function RunTotals({ run, total }: { run: RunSummary; total: number }) {
  const live = run.finished === null;
  useNow(live);
  const usage = summaryUsageMetric(run);
  return (
    <div className="run-totals mono">
      <span className="run-total" title={live ? `running since ${run.started}` : `${run.started} to ${run.finished}`}>
        {fmtDur(run.started, run.finished)}
      </span>
      <span className={usage.present ? "run-total" : "run-total missing"} title={usage.title}>
        {usage.text}
      </span>
      <span className="run-total" title={`${run.counts.done} of ${total} nodes done`}>
        {`${run.counts.done}/${total} done`}
      </span>
    </div>
  );
}

export function RunRow({ run, health = null }: { run: RunSummary; health?: RunHealth | null }) {
  const total = totalOf(run.counts);
  const extra = run as RunSummary & { stale?: unknown; updated?: unknown };
  const staleCount = typeof extra.stale === "number" ? extra.stale : 0;
  const updated = typeof extra.updated === "string" && extra.updated !== "" ? extra.updated : null;
  const when = run.status === "running" ? `started ${rel(run.started)}` : `finished ${rel(run.finished)}`;
  return (
    <a className={`run-row is-${run.status}`} title={run.started} role="listitem" href={`#/run/${encodeURIComponent(run.run_id)}`}>
      <div>
        <div className="title">{run.title || run.run_id}</div>
        <div className="id mono">{run.run_id}</div>
        <RunTotals run={run} total={total} />
        <RunHealthSummary health={health} />
      </div>
      <Chip status={run.status} />
      <StatusBar counts={run.counts} total={total} />
      <div className="counts">
        <b>{`${run.counts.done}/${total}`}</b>
        {" done"}
        {run.counts.running > 0 ? `, ${run.counts.running} running` : ""}
        {run.counts.error > 0 ? `, ${run.counts.error} failed` : ""}
      </div>
      <div className="when muted" title={run.finished ?? run.started}>
        {when}
        {updated === null ? null : (
          <div className="run-updated" title={updated}>{`updated ${rel(updated)}`}</div>
        )}
        {staleCount > 0 ? (
          <span className="chip stale run-stale" title={`${staleCount} running node(s) quiet past the stale limit`}>{`${staleCount} stale`}</span>
        ) : null}
      </div>
    </a>
  );
}

/** Active runs first, then newest `started` first. */
export function sortedRuns(runs: readonly RunSummary[]): RunSummary[] {
  return runs.slice().sort((a, b) => {
    const rankA = a.status === "running" ? 0 : 1;
    const rankB = b.status === "running" ? 0 : 1;
    return rankA - rankB || b.started.localeCompare(a.started);
  });
}

// A loop is also a run (its id starts with "loop-"); the Loops tile counts it, so this one does not.
const isLoopRun = (run: RunSummary): boolean => run.run_id.startsWith("loop-");

function Kpis({ allRuns, active }: { allRuns: readonly RunSummary[]; active: readonly ActiveItem[] }) {
  const runs = allRuns.filter((run) => !isLoopRun(run));
  const running = runs.filter((run) => run.status === "running").length;
  const failedRuns = runs.filter((run) => run.status === "error").length;
  const failed = failedRuns + active.filter((item) => item.status === "failed").length;
  const attention = failedRuns + active.filter((item) => item.status !== "running").length;
  const loops = active.filter((item) => item.kind === "loop" && item.status === "running");
  const watches = active.filter((item) => item.kind === "watch" && item.status === "running");
  const events = watches.reduce((sum, item) => sum + (item.events ?? 0), 0);
  const soonest = loops
    .map((item) => item.next ?? 0)
    .filter((next) => next > 0)
    .sort((a, b) => a - b)[0];
  const stat = (label: string, value: string, tone: string, title?: string) => (
    <span className={`runs-stat ${tone}`} title={title}>
      <b>{value}</b> {label}
    </span>
  );
  return (
    <div className="runs-summary" role="status">
      {stat("running", String(running), running > 0 ? "is-running" : "", `of ${runs.length} in the last window`)}
      {stat("need attention", String(attention), failed > 0 ? "is-error" : attention > 0 ? "is-lost" : "", "failed runs, loops or monitors")}
      {stat("loops", String(loops.length), "", soonest === undefined ? "none running" : `next tick in ${until(soonest)}`)}
      {stat("monitors", String(watches.length), "", `${events} ${events === 1 ? "event" : "events"} captured`)}
    </div>
  );
}

export function FilterBar({ filters, onChange }: { filters: RunFilters; onChange: (next: RunFilters) => void }) {
  return (
    <div className="filter-bar" role="search">
      <Labelled label="Age">
        <Segmented
          label="Age"
          value={filters.age}
          options={RUN_AGE_VALUES.map((age) => ({ value: age, label: AGE_LABELS[age] }))}
          onChange={(next) => {
            onChange({ ...filters, age: next as RunFilters["age"] });
          }}
        />
      </Labelled>
      <Labelled label="Status">
        <Segmented
          label="Status"
          value={filters.status}
          options={[{ value: ALL_STATUSES, label: "All" }, ...RUN_STATUSES.map((status) => ({ value: status, label: status }))]}
          onChange={(next) => {
            onChange({ ...filters, status: next as RunFilters["status"] });
          }}
        />
      </Labelled>
      {runFiltersActive(filters) ? (
        <button
          className="btn"
          type="button"
          onClick={() => {
            onChange({ ...DEFAULT_RUN_FILTERS });
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function subtitle(visible: readonly RunSummary[], hidden: number): string {
  const active = visible.filter((run) => run.status === "running").length;
  const counted = `${active} active, ${visible.length - active} finished`;
  return hidden === 0 ? counted : `${counted} — ${hidden} hidden by filters`;
}

/** `#/`: KPI tiles, the loops-and-monitors strip, filters and the run rows. */
export function RunsPage() {
  const runsQuery = useRuns();
  const active = useActive().data?.items ?? [];
  const [filters, setFilters] = useState<RunFilters>(loadRunFilters);
  const apply = (next: RunFilters): void => {
    setFilters(next);
    saveRunFilters(next);
  };
  const loaded = runsQuery.data?.runs ?? null;
  const all = sortedRuns(loaded ?? []);
  const runs = all.filter((run) => matchesRunFilters(run, filters, Date.now()));
  const hidden = all.length - runs.length;
  const healthByRun = useRunsHealth(all.filter((run) => run.status === "running").map((run) => run.run_id));
  const head = <PageHead title="Runs" subtitle={all.length > 0 ? subtitle(runs, hidden) : "Nothing has been dispatched yet."} />;
  if (loaded === null) {
    return (
      <>
        {head}
        {runsQuery.isError ? <div className="notice">{`Could not load runs: ${runsQuery.error.message}`}</div> : <Skeleton rows={4} />}
      </>
    );
  }
  return (
    <>
      {head}
      <Kpis allRuns={all} active={active} />
      <ActiveStrip items={active} />
      <div className="section-head">
        <h2 className="section-title">Recent runs</h2>
        <span className="section-meta">{`${runs.length} of ${all.length}`}</span>
      </div>
      {all.length === 0 ? (
        <EmptyState title="No runs yet">
          <span>
            Start one with <code>dispatch.ts run start "&lt;title&gt;"</code>, then add nodes and dispatch them.
          </span>
        </EmptyState>
      ) : (
        <>
          <FilterBar filters={filters} onChange={apply} />
          {runs.length === 0 ? (
            <EmptyState
              title="No runs match the filters"
              action={
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    apply({ ...SHOW_ALL_RUN_FILTERS });
                  }}
                >
                  Show all runs
                </button>
              }
            >
              {`The current filters hide all ${hidden} ${hidden === 1 ? "run" : "runs"}. Widen the age or press Show all runs.`}
            </EmptyState>
          ) : (
            <div className="runs" role="list">
              {runs.map((run) => (
                <RunRow key={run.run_id} run={run} health={healthByRun.get(run.run_id) ?? null} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
