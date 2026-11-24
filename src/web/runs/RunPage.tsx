import "./runs.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState } from "../../shared/types/run-state";
import type { RunNode } from "../../shared/types/run-node";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { Chip } from "../components/Chip";
import { PageLoader } from "../components/Skeleton";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { fmtTime } from "../lib/format";
import { runTotals } from "../lib/node-metrics";
import { runUpdatedAt } from "../lib/run-activity";
import type { RunEvent } from "../../shared/types/run-event";
import type { Metric } from "../lib/node-metrics";
import { GraphViewport } from "./GraphViewport";
import { NodePanel } from "./NodePanel";
import { hasUnreviewed, unreviewedNodes } from "../lib/node-flags";
import { ActivityFeed, Ago } from "./RunActivity";
import { isNotFound, useProfileFacts, useRun, useRuns, useRunEvents, useRunHealth, useRunProjection, useWatchdog, type LiveState } from "./queries";
import { hashWithFilter, isFilterActive, matchesFilter, parseFilter, runSummary, type NodeFilter } from "./run-filter";
import { LiveIndicator, NodeFilterBar, RunSummaryBar } from "./RunToolbar";
import { CoordinatorBlock } from "./CoordinatorBlock";
import { MarkerSummary } from "./NodeMarkers";
import { NodeMarkerContext } from "./node-marker-context";
import { idsWithMarker, markerMap, type MarkerCode } from "../lib/node-markers";
import { RequirementsPanel } from "./RunRequirements";
import { NextActions } from "./RunNextActions";
import { RunOverview } from "./RunOverview";
import { refetchRun } from "./run-actions";
import { describeChanges, snapshotRun, type RunSnapshot } from "./run-attention";
import { FailureBanner, RunStateNotice } from "./RunAttention";
import { useNow } from "./use-now";
import { RunTable, ViewSwitch } from "./RunTable";
import { hashWithView, loadRunView, parseViewParam, saveRunView, type RunView } from "../lib/run-table";
import { CoveredByLink, CoversBlock } from "./RunCover";
import { ActiveStrip } from "./ActiveStrip";
import { useActive } from "../api/queries";
import { RunWatchdog } from "./RunWatchdog";
import { RunParallel } from "./RunParallel";
import { parseNodeParam } from "../lib/covered-node";

const runTitle = (run: RunState): string => run.title || run.run_id;

function Stat({ k, value, cls = "", title }: { k: string; value: string; cls?: string; title?: string }) {
  return (
    <span className={cls === "" ? "run-stat" : `run-stat ${cls}`} title={title === "" ? undefined : title}>
      <span className="run-stat-key">{k}</span>
      <b>{value}</b>
    </span>
  );
}

function MetricStat({ k, metric }: { k: string; metric: Metric }) {
  return <Stat k={k} value={metric.text} cls={metric.present ? "" : "missing"} title={metric.title} />;
}

function RunMeta({ run, events }: { run: RunState; events: readonly RunEvent[] }) {
  const live = run.finished === null;
  useNow(live);
  const totals = runTotals(run);
  const updatedAt = runUpdatedAt(run, events);
  return (
    <div className="meta run-meta" role="list">
      <Stat k="run" value={run.run_id} cls="mono" />
      <Stat k="started" value={fmtTime(run.started)} />
      {run.finished === null ? null : <Stat k="finished" value={fmtTime(run.finished)} />}
      <MetricStat k={live ? "elapsed" : "duration"} metric={totals.duration} />
      <MetricStat k="usage" metric={totals.usage} />
      {updatedAt === null ? null : (
        <span className="run-stat" title={fmtTime(updatedAt)}>
          <span className="run-stat-key">updated</span>
          <b>
            <Ago iso={updatedAt} />
          </b>
        </span>
      )}
      <Stat k="nodes" value={`${totals.done}/${totals.total} done`} cls="run-stat-done" />
      {run.harness_session === "" ? null : <Stat k="session" value={run.harness_session} cls="mono" />}
    </div>
  );
}

function RunActions({ run }: { run: RunState }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<"retry" | "stop" | "pause" | "resume" | null>(null);
  const hasFailed = run.nodes.some((node) => node.status === "error");
  const stopped = run.stopped === true;
  const paused = run.paused === true;
  if (!hasFailed && run.status !== "running" && !stopped && !paused) {
    return null;
  }
  const pause = (): void => {
    setBusy("pause");
    void api.pauseRun(run.run_id).then((result) => {
      setBusy(null);
      if (result.kind === "ok") {
        toast("ok", "Run paused");
        void refetchRun(run.run_id);
      } else {
        toast("error", describeFailure(result, "Pause failed"));
      }
    });
  };
  const resume = (): void => {
    setBusy("resume");
    void api.resumeRun(run.run_id).then((result) => {
      setBusy(null);
      if (result.kind === "ok") {
        toast("ok", "Run resumed");
        void refetchRun(run.run_id);
      } else {
        toast("error", describeFailure(result, "Resume failed"));
      }
    });
  };
  const retry = (): void => {
    setBusy("retry");
    void api.retryRun(run.run_id).then((result) => {
      setBusy(null);
      if (result.kind === "ok") {
        toast("ok", "Retrying failed nodes");
        void refetchRun(run.run_id);
      } else {
        toast("error", describeFailure(result, "Retry failed"));
      }
    });
  };
  const stop = async (): Promise<void> => {
    const running = run.nodes.filter((node) => node.status === "running").length;
    const confirmed = await confirm({
      title: `Stop run ${runTitle(run)}?`,
      body: `This kills ${running} running job(s) and marks those nodes stopped. The run does not resume by itself; use Resume to continue it.`,
      confirmLabel: "Stop run",
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    setBusy("stop");
    const result = await api.stopRun(run.run_id);
    setBusy(null);
    if (result.kind === "ok") {
      toast("ok", "Run stopped");
      void refetchRun(run.run_id);
    } else {
      toast("error", describeFailure(result, "Stop failed"));
    }
  };
  return (
    <div className="actions run-actions">
      {hasFailed ? (
        <button className="btn primary" type="button" disabled={busy === "retry"} onClick={retry}>
          Retry failed nodes
        </button>
      ) : null}
      {stopped || paused ? (
        <button className="btn primary" type="button" disabled={busy === "resume"} onClick={resume}>
          Resume
        </button>
      ) : null}
      {run.status === "running" && !stopped && !paused ? (
        <button className="btn" type="button" disabled={busy === "pause"} onClick={pause}>
          Pause
        </button>
      ) : null}
      {run.status === "running" && !stopped ? (
        <button
          className="btn danger"
          type="button"
          disabled={busy === "stop"}
          onClick={() => {
            void stop();
          }}
        >
          Stop run
        </button>
      ) : null}
      {run.status === "running" ? <RunParallel run={run} /> : null}
    </div>
  );
}

/** The node filter, read from and written back to the hash query (`#/run/<id>?status=error`) with replaceState. */
function useNodeFilter(): [NodeFilter, (next: NodeFilter) => void] {
  const [filter, setState] = useState<NodeFilter>(() => parseFilter(location.hash));
  useEffect(() => {
    const onHash = (): void => setState(parseFilter(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const setFilter = useCallback((next: NodeFilter): void => {
    setState(next);
    const hash = hashWithFilter(location.hash, next);
    if (hash !== location.hash) {
      history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    }
  }, []);
  return [filter, setFilter];
}

function RunBody({ run, live }: { run: RunState; live: LiveState }) {
  const facts = useProfileFacts();
  const [filter, setFilter] = useNodeFilter();
  const summary = useMemo(() => runSummary(run), [run]);
  const harnessKey = JSON.stringify(facts.harnessByProfile);
  const harnessByProfile = useMemo(() => JSON.parse(harnessKey) as Record<string, string>, [harnessKey]);
  const [markerFilter, setMarkerFilter] = useState<MarkerCode | "">("");
  const [selected, setSelected] = useState<string | null>(() => parseNodeParam(location.hash));
  const [runView, setRunView] = useState<RunView>(() => parseViewParam(location.hash) ?? loadRunView());
  useEffect(() => {
    const onHash = (): void => {
      const node = parseNodeParam(location.hash);
      if (node !== null) {
        setSelected(node);
      }
      const v = parseViewParam(location.hash);
      if (v !== null) {
        setRunView(v);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const changeView = (next: RunView): void => {
    setRunView(next);
    saveRunView(next);
    history.replaceState(history.state, "", `${location.pathname}${location.search}${hashWithView(location.hash, next)}`);
  };
  const [flash, setFlash] = useState(0);
  const hasSelection = run.nodes.some((node) => node.id === selected);
  const events = useRunEvents(run.run_id, run.status === "running");
  const health = useRunHealth(run.run_id, run.status === "running");
  const projection = useRunProjection(run.run_id, run.status === "running");
  const allRuns = useRuns({ poll: false }).data?.runs ?? [];
  const engine = useActive().data?.items.filter((item) => item.id === run.run_id) ?? [];
  const watchdog = useWatchdog();
  const toast = useToast();
  const lastSnapshot = useRef<RunSnapshot | null>(null);
  const nowMs = useNow(run.nodes.some((node) => node.status === "running"));
  const readyKey = (projection?.ready ?? []).join("|");
  const markers = useMemo(
    () => markerMap(run, { nowMs, ready: new Set(readyKey === "" ? [] : readyKey.split("|")) }, health?.nodes ?? []),
    [run, nowMs, readyKey, health],
  );
  const markerIds = useMemo(() => (markerFilter === "" ? null : idsWithMarker(markers, markerFilter)), [markers, markerFilter]);
  const match = useMemo(
    () =>
      isFilterActive(filter) || markerIds !== null
        ? (node: RunNode) => (markerIds === null || markerIds.has(node.id)) && (!isFilterActive(filter) || matchesFilter(run, node, filter, harnessByProfile))
        : null,
    [run, filter, harnessByProfile, markerIds],
  );
  const shownCount = match === null ? run.nodes.length : run.nodes.filter(match).length;
  useEffect(() => {
    const next = snapshotRun(run);
    for (const change of describeChanges(lastSnapshot.current, next)) {
      toast(change.kind, change.text);
    }
    lastSnapshot.current = next;
  }, [run, toast]);
  return (
    <NodeMarkerContext.Provider value={markers}>
    <div className="run-page">
      <div className="run-page-header">
        <div className="run-head">
          <h1>{runTitle(run)}</h1>
          <Chip status={run.status} />
          <CoveredByLink run={run} runs={allRuns} />
          {run.force_finish_reason ? <span className="muted run-forced">forced finish: {run.force_finish_reason}</span> : null}
          <a className="muted" href="#/">
            ← all runs
          </a>
          <ViewSwitch view={runView} onChange={changeView} />
          <RunActions run={run} />
          <LiveIndicator state={live} />
        </div>
        <RunMeta run={run} events={events} />
        <ActiveStrip items={engine} />
        <RunWatchdog runId={run.run_id} status={watchdog} flags={projection?.supervisor.flags ?? []} />
        <RunSummaryBar summary={summary} active={filter.status} onPick={(status) => setFilter({ ...filter, status })} />
        <div className="run-filter-row">
          <NodeFilterBar run={run} filter={filter} harnessByProfile={facts.harnessByProfile} shown={shownCount} onChange={setFilter} />
          <ActivityFeed events={events} />
        </div>
        <CoordinatorBlock runId={run.run_id} state={run.orchestrator_state ?? run.coordinator_state} />
        <RunStateNotice run={run} />
        <FailureBanner run={run} />
        <MarkerSummary map={markers} active={markerFilter} onPick={setMarkerFilter} />
        <RequirementsPanel requirements={projection?.requirements ?? []} onSelect={setSelected} />
        <NextActions actions={projection?.next_actions ?? []} onSelect={setSelected} />
        <RunOverview runId={run.run_id} onSelect={setSelected} />
        {hasUnreviewed(run.nodes) ? <UnreviewedBanner nodes={unreviewedNodes(run.nodes)} onSelect={setSelected} /> : null}
      </div>
      <div className="layout run-layout">
        {runView === "table" ? (
          <RunTable
            run={run}
            filter={filter}
            only={markerIds}
            harnessByProfile={facts.harnessByProfile}
            selectedId={selected}
            onSelect={(id) => {
              setSelected(id);
              setFlash((n) => n + 1);
            }}
          />
        ) : (
        <GraphViewport
          run={run}
          selectedId={selected}
          onSelect={(id) => {
            setSelected(id);
            setFlash((n) => n + 1);
          }}
          harnessByProfile={facts.harnessByProfile}
          maxAttempts={facts.maxAttempts}
          match={match}
        />
        )}
      </div>
      {hasSelection ? (
        <NodePanel run={run} selectedId={selected} maxAttempts={facts.maxAttempts} flash={flash} onClose={() => setSelected(null)} />
      ) : null}
      <CoversBlock runId={run.run_id} runs={allRuns} />
    </div>
    </NodeMarkerContext.Provider>
  );
}

/** `#/run/<id>`: header with totals and actions, the graph and the node panel, then the covers block. Remounted per run id. */
export function RunPage({ runId }: { runId: string }) {
  const query = useRun(runId);
  const run = query.data?.run ?? null;
  if (run === null) {
    const missing = isNotFound(query.error);
    return (
      <>
        <h1>{runId}</h1>
        {missing ? (
          <>
            <div className="notice">Run not found — it may have been pruned.</div>
            <a href="#/">← Back to runs</a>
          </>
        ) : query.isError ? (
          <div className="notice">{`Could not load the run: ${query.error instanceof Error ? query.error.message : "request failed"}`}</div>
        ) : (
          <PageLoader label="Loading run…" onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }
  return <RunBody key={run.run_id} run={run} live={query.isError ? "offline" : query.live} />;
}

/** One line naming the done nodes that need a review and why; a click selects the node. */
function UnreviewedBanner({ nodes, onSelect }: { nodes: Array<{ id: string; reason: string }>; onSelect: (id: string) => void }) {
  return (
    <div className="notice warn run-stale-banner" role="status">
      <b>{nodes.length === 1 ? "1 node needs review" : `${nodes.length} nodes need review`}</b>
      <span>
        {nodes.slice(0, 5).map((n, i) => (
          <span key={n.id}>
            {i > 0 ? ", " : ""}
            <button type="button" className="link-btn" onClick={() => onSelect(n.id)}>{n.id}</button> ({n.reason})
          </span>
        ))}
        {nodes.length > 5 ? `, ${nodes.length - 5} more` : ""}. A recorded result (`node result`) clears it.
      </span>
    </div>
  );
}
