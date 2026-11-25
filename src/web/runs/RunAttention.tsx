import "./runs.css";
import { useState } from "react";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { fmtTime } from "../lib/format";
import { isLongRunning, LONG_RUNNING_MS, pausedNodes, runningMinutes } from "./run-attention";
import { refetchRun } from "./run-actions";

/** Paused or stopped state of the run, with the running nodes it holds. */
export function RunStateNotice({ run }: { run: RunState }) {
  if (run.stopped === true) {
    return (
      <div className="notice run-state-notice stopped" role="status">
        <b>Run stopped.</b>
        <span>It does not resume by itself. Click Resume to continue.</span>
      </div>
    );
  }
  if (run.paused === true) {
    const held = pausedNodes(run);
    return (
      <div className="notice run-state-notice paused" role="status">
        <b>Run paused{run.paused_at ? ` since ${fmtTime(run.paused_at)}` : ""}.</b>
        <span>
          {held.length === 0
            ? "No node is running. No node starts until Resume."
            : `Paused nodes (keep their session, re-run on Resume): ${held.map((node) => node.id).join(", ")}.`}
        </span>
      </div>
    );
  }
  return null;
}

/** Error nodes with their message. Shown above the graph, so a failure is not missed. */
function LongRunningRow({ runId, node, nowMs }: { runId: string; node: RunNode; nowMs: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"cancel" | "restart" | null>(null);
  const cancel = async (): Promise<boolean> => {
    const result = await api.cancelNode(runId, node.id);
    if (result.kind !== "ok") {
      toast("error", describeFailure(result, `Cancel ${node.id} failed`));
      return false;
    }
    toast("ok", `${node.id} cancelled`);
    return true;
  };
  const run = async (action: "cancel" | "restart"): Promise<void> => {
    setBusy(action);
    if (action === "cancel") {
      await cancel();
    } else if (await cancel()) {
      const result = await api.retryNode(runId, node.id);
      if (result.kind === "ok") {
        toast("ok", `${node.id} restarted`);
      } else {
        toast("error", describeFailure(result, `Restart ${node.id} failed`));
      }
    }
    setBusy(null);
    await refetchRun(runId);
  };
  return (
    <li className="run-long-row">
      <span className="mono">{node.id}</span>
      <span>running {runningMinutes(node, nowMs)} min</span>
      <button className="btn" type="button" disabled={busy !== null} onClick={() => void run("cancel")}>
        Cancel
      </button>
      <button className="btn" type="button" disabled={busy !== null} onClick={() => void run("restart")}>
        Restart
      </button>
    </li>
  );
}

/** Running nodes past the threshold. Cancel and Restart act on that one node only. */
export function LongRunningBanner({ run, nowMs, thresholdMs = LONG_RUNNING_MS }: { run: RunState; nowMs: number; thresholdMs?: number }) {
  const long = run.nodes.filter((node) => isLongRunning(node, nowMs, thresholdMs));
  if (long.length === 0) {
    return null;
  }
  return (
    <div className="notice run-long-banner" role="status">
      <b>
        {long.length} node{long.length === 1 ? "" : "s"} running longer than {Math.round(thresholdMs / 60000)} min
      </b>
      <ul className="run-banner-list">
        {long.map((node) => (
          <LongRunningRow key={node.id} runId={run.run_id} node={node} nowMs={nowMs} />
        ))}
      </ul>
    </div>
  );
}
