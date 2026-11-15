import { Suspense, lazy, useState } from "react";
import { formatDuration } from "../lib/duration";
import { formatTokens, isLive, messageDurationMs, messageNotes } from "../lib/chat-logic";
import type { Attachment, Message } from "../lib/chat-types";
import { fmtUsd } from "../lib/format";
import { AttachmentTile } from "./Attachments";

const Markdown = lazy(() => import("./Markdown"));

interface MessageViewProps {
  message: Message;
  now: number;
  onOpenImage: (a: Attachment) => void;
  onRetry?: (() => void) | undefined;
  /** The model the chat is configured with, shown when the agent reported none. */
  fallbackModel?: string | undefined;
}

function Footer({ message, now, fallbackModel }: { message: Message; now: number; fallbackModel?: string | undefined }) {
  const ms = messageDurationMs(message, now);
  const tokens = formatTokens(message.input_tokens, message.output_tokens);
  return (
    <div className="msg-foot" data-testid="msg-foot">
      <span className={`msg-status is-${message.status}`}>{message.status}</span>
      {message.model_used !== null ? (
        <span className="msg-meta mono" data-testid="msg-model">{message.model_used}</span>
      ) : fallbackModel !== undefined ? (
        <span className="msg-meta mono" data-testid="msg-model" title="The agent reported no model: this is the one the chat is set to">{fallbackModel}</span>
      ) : null}
      {ms !== null ? <span className="msg-meta mono" data-testid="msg-duration">{formatDuration(ms)}</span> : null}
      {tokens !== null ? <span className="msg-meta mono">{tokens}</span> : null}
      {message.cost_usd !== null ? <span className="msg-meta mono">{fmtUsd(message.cost_usd)}</span> : null}
    </div>
  );
}

function ToolRow({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const colon = message.content.indexOf(":");
  const name = colon < 0 ? message.content : message.content.slice(0, colon);
  const input = colon < 0 ? "" : message.content.slice(colon + 1).trim();
  return (
    <div className="tool-row">
      <button type="button" className="tool-toggle" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <span className="tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="tool-name mono">{name}</span>
        {!open && input !== "" ? <span className="tool-short mono">{input}</span> : null}
      </button>
      {open ? <pre className="tool-body">{input === "" ? name : input}</pre> : null}
    </div>
  );
}

export function MessageView({ message, now, onOpenImage, onRetry, fallbackModel }: MessageViewProps) {
  if (message.role === "tool") {
    return <ToolRow message={message} />;
  }
  const live = isLive(message);
  if (message.role === "user") {
    return (
      <div className="msg msg-user" data-role="user">
        <div className="bubble">
          {message.content !== "" ? <p className="user-text">{message.content}</p> : null}
          {message.attachments.length > 0 ? (
            <div className="att-row">
              {message.attachments.map((a) => (
                <AttachmentTile key={a.id} attachment={a} onOpen={onOpenImage} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant" data-role={message.role}>
      <div className="bubble">
        {message.content === "" && live ? <span className="thinking">Thinking</span> : (
          <Suspense fallback={<p className="user-text">{message.content}</p>}>
            <Markdown text={message.content} live={live} />
          </Suspense>
        )}
        {message.status === "error" ? (
          <div className="msg-error" role="alert">
            <span>{message.error ?? "The reply failed."}</span>
            {onRetry !== undefined ? (
              <button type="button" className="btn" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Footer message={message} now={now} fallbackModel={fallbackModel} />
      {messageNotes(message).map((n) => (
        <p key={n.key} className="msg-warning" data-testid={`msg-${n.key}`} title={n.title}>{n.text}</p>
      ))}
    </div>
  );
}

