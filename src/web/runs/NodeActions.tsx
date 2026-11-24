import { useState } from "react";
import type { RunNode } from "../../shared/types/run-node";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { nodeWarnings } from "../lib/node-warnings";
import { refetchRun } from "./run-actions";

/** Inline warnings, one line each. Renders nothing for a healthy node. */
export function NodeWarnings({ node }: { node: RunNode }) {
  const warnings = nodeWarnings(node);
  if (warnings.length === 0) {
    return null;
  }
  return (
    <ul className="node-warnings" aria-label="Node warnings">
      {warnings.map((w) => (
        <li key={w.code} className={`node-warning is-${w.tone}`} data-code={w.code}>
          {w.text}
        </li>
      ))}
    </ul>
  );
}

/** Retry (error/skipped), Tell (any node, inline input) and Stop (running, confirmed). */
export function NodeActions({ runId, node, confirmStop = (text: string) => window.confirm(text) }: { runId: string; node: RunNode; confirmStop?: (text: string) => boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [telling, setTelling] = useState(false);
  const [text, setText] = useState("");
  const run = (call: () => Promise<{ kind: string }>, ok: string, fail: string) => {
    setBusy(true);
    void call().then((result) => {
      setBusy(false);
      if (result.kind === "ok") {
        toast("ok", ok);
        void refetchRun(runId);
      } else {
        toast("error", describeFailure(result as never, fail));
      }
    });
  };
  return (
    <div className="node-actions" role="group" aria-label="Node actions">
      {node.status === "error" || node.status === "skipped" ? (
        <button className="btn primary" type="button" disabled={busy} onClick={() => run(() => api.retryNode(runId, node.id), `Retrying ${node.id}`, "Retry failed")}>
          Retry
        </button>
      ) : null}
      <button className="btn" type="button" aria-expanded={telling} onClick={() => setTelling(!telling)}>
        Tell
      </button>
      {node.status === "running" ? (
        <button
          className="btn danger"
          type="button"
          disabled={busy}
          onClick={() => {
            if (confirmStop(`Stop ${node.id}? Its running job is killed.`)) {
              run(() => api.cancelNode(runId, node.id), `Stopped ${node.id}`, "Stop failed");
            }
          }}
        >
          Stop
        </button>
      ) : null}
      {telling ? (
        <form
          className="node-tell"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === "") {
              return;
            }
            run(() => api.tellNode(runId, node.id, text.trim()), `Sent to ${node.id}`, "Tell failed");
            setText("");
            setTelling(false);
          }}
        >
          <input aria-label={`Message to ${node.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message to the node" />
          <button className="btn primary" type="submit" disabled={busy || text.trim() === ""}>
            Send
          </button>
        </form>
      ) : null}
    </div>
  );
}
