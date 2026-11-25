import "./runs.css";
import { useState } from "react";
import type { RunNode } from "../../shared/types/run-node";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { useToastOptional } from "../components/Toast";
import { MARKER_ICON, markerCounts, type MarkerCode, type NodeMarker } from "../lib/node-markers";
import { ReasonDialog } from "./ReasonDialog";
import { refetchRun } from "./run-actions";

/** One marker: icon and short word in the status colours. */
export function MarkerChip({ marker }: { marker: NodeMarker }) {
  return (
    <span className={`node-marker is-${marker.tone}`} data-marker={marker.code} title={marker.title}>
      <span aria-hidden="true">{MARKER_ICON[marker.code]}</span>
      <span>{marker.word}</span>
    </span>
  );
}

export function NodeMarkerList({ markers }: { markers: readonly NodeMarker[] }) {
  if (markers.length === 0) {
    return null;
  }
  return (
    <span className="node-markers" aria-label="Node markers">
      {markers.map((m) => (
        <MarkerChip key={m.code} marker={m} />
      ))}
    </span>
  );
}

export type NodeAction = "cancel" | "restart" | "start" | "tell" | "done" | "reviewed";

/** Which menu items apply to a node. Start uses the retry route: it re-queues a ready node. */
export function menuActions(node: RunNode, markers: readonly NodeMarker[]): Array<NodeAction> {
  const out: NodeAction[] = [];
  if (node.status === "running") {
    out.push("cancel", "restart");
  }
  if (node.status === "error" || node.status === "skipped") {
    out.push("restart");
  }
  if (markers.some((m) => m.code === "ready")) {
    out.push("start");
  }
  if (["waiting", "pending", "stopped", "error"].includes(node.status)) {
    out.push("done");
  }
  if (node.status === "done" && markers.some((m) => m.code === "review")) {
    out.push("reviewed");
  }
  out.push("tell");
  return out;
}

const LABEL = { cancel: "Cancel", restart: "Restart", start: "Start", tell: "Tell", done: "Mark done", reviewed: "Mark reviewed" } as const;

/** Compact "⋯" action menu for one node: Cancel, Restart, Start, Tell. Cancel asks once more inline. */
export function NodeMenu({ runId, node, markers, className = "" }: { runId: string; node: RunNode; markers: readonly NodeMarker[]; className?: string }) {
  const toast = useToastOptional();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [telling, setTelling] = useState(false);
  const [text, setText] = useState("");
  const [marking, setMarking] = useState<"done" | "reviewed" | null>(null);
  const close = (): void => {
    setOpen(false);
    setConfirm(false);
    setTelling(false);
  };
  const run = (call: () => Promise<{ kind: string }>, ok: string, fail: string): void => {
    setBusy(true);
    void call().then((result) => {
      setBusy(false);
      if (result.kind === "ok") {
        toast("ok", ok);
        close();
        void refetchRun(runId);
      } else {
        toast("error", describeFailure(result as never, fail));
      }
    });
  };
  const act = (action: NodeAction): void => {
    if (action === "done" || action === "reviewed") {
      setMarking(action);
      setOpen(false);
    } else if (action === "tell") {
      setTelling(true);
    } else if (action === "cancel") {
      if (!confirm) {
        setConfirm(true);
        return;
      }
      run(() => api.cancelNode(runId, node.id), `${node.id} cancelled`, `Cancel ${node.id} failed`);
    } else if (action === "restart") {
      const retry = () => api.retryNode(runId, node.id);
      run(async () => (node.status === "running" ? (await api.cancelNode(runId, node.id)).kind === "ok" ? retry() : { kind: "error" } : retry()), `${node.id} restarted`, `Restart ${node.id} failed`);
    } else {
      run(() => api.retryNode(runId, node.id), `${node.id} started`, `Start ${node.id} failed`);
    }
  };
  const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();
  return (
    <span
      className={`node-menu${open ? " is-open" : ""} ${className}`.trim()}
      onClick={stop}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          close();
        }
      }}
    >
      <button className="node-menu-btn" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${node.id}`} title="Actions" onClick={() => (open ? close() : setOpen(true))}>
        ⋯
      </button>
      {open ? (
        <span className="node-menu-list" role="menu" aria-label={`Actions for ${node.id}`}>
          {menuActions(node, markers).map((action) => (
            <button key={action} role="menuitem" type="button" className={`node-menu-item${action === "cancel" ? " is-warn" : ""}`} disabled={busy} onClick={() => act(action)}>
              {action === "cancel" && confirm ? "Confirm cancel" : LABEL[action]}
            </button>
          ))}
          {telling ? (
            <form
              className="node-menu-tell"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim() !== "") {
                  run(() => api.tellNode(runId, node.id, text.trim()), `Sent to ${node.id}`, "Tell failed");
                  setText("");
                }
              }}
            >
              <input aria-label={`Message to ${node.id}`} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Message to the node" />
            </form>
          ) : null}
        </span>
      ) : null}
      {marking === null ? null : (
        <ReasonDialog
          title={marking === "done" ? `Mark ${node.id} done?` : `Mark ${node.id} reviewed?`}
          intro={marking === "done" ? "Sets the node done without running it." : "Records a full result: you checked this node."}
          confirmLabel="Confirm"
          reasonRequired={marking === "reviewed"}
          runId={runId}
          call={(reason) => (marking === "done" ? api.markNodeDone(runId, node.id, reason) : api.markNodeReviewed(runId, node.id, reason))}
          done={marking === "done" ? `${node.id} marked done` : `${node.id} marked reviewed`}
          onClose={() => setMarking(null)}
        />
      )}
    </span>
  );
}

/** The one thin line that may stay above the graph, "2 stalled · 3 ready". A click filters to those nodes. */
export function MarkerSummary({ map, active, onPick }: { map: ReadonlyMap<string, readonly NodeMarker[]>; active: MarkerCode | ""; onPick: (code: MarkerCode | "") => void }) {
  const counts = markerCounts(map);
  if (counts.length === 0) {
    return null;
  }
  return (
    <div className="marker-summary" role="group" aria-label="Node markers summary">
      {counts.map(({ code, count }, i) => (
        <span key={code}>
          {i === 0 ? null : <span className="marker-sep" aria-hidden="true"> · </span>}
          <button type="button" data-code={code} className={`marker-summary-btn${active === code ? " is-on" : ""}`} aria-pressed={active === code} onClick={() => onPick(active === code ? "" : code)}>
            <span aria-hidden="true">{MARKER_ICON[code]}</span> {count} {code === "long" ? "long-running" : code === "review" ? "need review" : code}
          </button>
        </span>
      ))}
      {active === "" ? null : (
        <button type="button" className="marker-summary-clear" onClick={() => onPick("")}>
          clear
        </button>
      )}
    </div>
  );
}
