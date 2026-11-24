import { useState, type ReactNode } from "react";
import type { RunNode } from "../../shared/types/run-node";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { canMessage, messageLine, nodeThread, openAsks } from "../lib/node-messages";
import { queryClient } from "../api/queries";
import { runKeys, useRunMessages } from "./queries";

/**
 * The node's messages: its open questions with an Answer button, the recent thread, and a Send box
 * (`node tell`). A running node gets the text in its herdr pane or inbox; a waiting node gets it in
 * its prompt when it starts.
 */
export function NodeMessages({ runId, node, children = null }: { runId: string; node: RunNode; children?: ReactNode }) {
  const toast = useToast();
  const live = canMessage(node.status);
  const messages = useRunMessages(runId, live);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const all = messages.data ?? [];
  const asks = openAsks(all, node.id);
  const thread = nodeThread(all, node.id);
  if (!live && thread.length === 0) {
    return children === null ? null : <section className="node-messages is-readonly" aria-label="Session">{children}</section>;
  }
  const trimmed = text.trim();

  function send(kind: "tell" | "answer", ask?: string): void {
    setBusy(true);
    const call = kind === "tell" ? api.tellNode(runId, node.id, trimmed) : api.answerNode(runId, node.id, trimmed, ask);
    void call.then((result) => {
      setBusy(false);
      if (result.kind === "ok") {
        setText("");
        toast("ok", kind === "tell" ? `Sent to ${node.id}` : `Answered ${ask ?? node.id}`);
        void queryClient.invalidateQueries({ queryKey: [runKeys.messages(runId)] });
      } else {
        toast("error", describeFailure(result, kind === "tell" ? "Send failed" : "Answer failed"));
      }
    });
  }

  return (
    <section className="node-messages" aria-label="Session and messages">
      <div className="term-stream">
        {children}
        {thread.map((m) => (
          <div className="term-user" key={m.id}>
            {messageLine(m)}
          </div>
        ))}
        {asks.map((ask) => (
          <div className="term-ask node-ask" key={ask.id} role="group" aria-label="Open question">
            <span className="term-ask-mark" aria-hidden="true">?</span>
            <span className="node-ask-text">{ask.text}</span>
            <button className="btn primary" type="button" disabled={busy || trimmed === ""} title="Answer with the text in the input below" onClick={() => send("answer", ask.id)}>
              Answer
            </button>
          </div>
        ))}
      </div>
      {live ? (
        <form
          className="node-send term-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "" && !busy) {
              send("tell");
            }
          }}
        >
          <textarea
            aria-label={`Message to ${node.id}`}
            placeholder={asks.length > 0 ? "Type an answer or a message" : `Message ${node.id}`}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button className="btn" type="submit" disabled={busy || trimmed === ""}>
            Send
          </button>
        </form>
      ) : null}
    </section>
  );
}
