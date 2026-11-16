import "./runs.css";
import { useState } from "react";
import type { NodeStatus } from "../../shared/types/node-status";
import type { RunState } from "../../shared/types/run-state";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { Chip } from "../components/Chip";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { STATUS_ORDER } from "../lib/constants";
import { fmtTime } from "../lib/format";
import { runTotals } from "../lib/node-metrics";
import { runUpdatedAt } from "../lib/run-activity";
import type { RunEvent } from "../../shared/types/run-event";
import type { Metric } from "../lib/node-metrics";
import { GraphViewport } from "./GraphViewport";
import { NodePanel } from "./NodePanel";
import { FINISHED_BY_OWNER, hasUnreviewed } from "../lib/node-flags";
import { ActivityFeed, Ago, StaleBanner } from "./RunActivity";
import { isNotFound, useProfileFacts, useRun, useRunEvents, useRunHealth } from "./queries";
import { NodeHealthStrip, ReadyNotice } from "./RunHealth";
import { refetchRun } from "./run-actions";
import { useNow } from "./use-now";

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
  const counts = new Map<NodeStatus, number>();
  for (const node of run.nodes) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
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
      {STATUS_ORDER.map((status) => {
        const count = counts.get(status) ?? 0;
        return count > 0 && status !== "done" ? <Stat key={status} k={status} value={String(count)} cls={`run-stat-${status}`} /> : null;
      })}
      {run.harness_session === "" ? null : <Stat k="session" value={run.harness_session} cls="mono" />}
    </div>
  );
}

function RunActions({ run }: { run: RunState }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<"retry" | "stop" | "resume" | null>(null);
  const hasFailed = run.nodes.some((node) => node.status === "error");
  const stopped = run.stopped === true;
  if (!hasFailed && run.status !== "running" && !stopped) {
    return null;
  }
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
      {stopped ? (
        <button className="btn primary" type="button" disabled={busy === "resume"} onClick={resume}>
          Resume
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
    </div>
  );
}

function RunBody({ run }: { run: RunState }) {
  const facts = useProfileFacts();
  const [selected, setSelected] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const events = useRunEvents(run.run_id);
  const health = useRunHealth(run.run_id, run.status === "running");
  return (
    <div className="run-page">
      <div className="run-page-header">
        <div className="run-head">
          <h1>{runTitle(run)}</h1>
          <Chip status={run.status} />
          <a className="muted" href="#/">
            ← all runs
          </a>
          <RunActions run={run} />
        </div>
        <RunMeta run={run} events={events} />
        <StaleBanner run={run} />
        <ReadyNotice health={health} />
        <NodeHealthStrip
          health={health}
          onSelect={(id) => {
            setSelected(id);
            setFlash((n) => n + 1);
          }}
        />
        {hasUnreviewed(run.nodes) ? (
          <div className="notice warn run-stale-banner" role="status">
            <b>{FINISHED_BY_OWNER}</b>
            <span>One or more nodes are done only because their owner stopped. Review them before relying on the result.</span>
          </div>
        ) : null}
      </div>
      <div className="layout run-layout">
        <GraphViewport
          run={run}
          selectedId={selected}
          onSelect={(id) => {
            setSelected(id);
            setFlash((n) => n + 1);
          }}
          harnessByProfile={facts.harnessByProfile}
          maxAttempts={facts.maxAttempts}
        />
        <NodePanel run={run} selectedId={selected} maxAttempts={facts.maxAttempts} flash={flash} onClose={() => setSelected(null)} />
      </div>
      <ActivityFeed events={events} />
    </div>
  );
}

/** `#/run/<id>`: header with totals and actions, the graph and the node panel. Remounted per run id. */
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
          <div className="sub">Loading…</div>
        )}
      </>
    );
  }
  return <RunBody key={run.run_id} run={run} />;
}
