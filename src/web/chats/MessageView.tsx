import { Suspense, lazy, useState } from "react";
import { autoLabel } from "../../shared/auto-model";
import { formatDuration } from "../lib/duration";
import { formatTokens, isLive, messageDurationMs, messageNotes } from "../lib/chat-logic";
import type { Attachment, Message } from "../lib/chat-types";
import { fmtUsd, rel } from "../lib/format";
import { AttachmentTile } from "./Attachments";
import { partsOf } from "./chat-group";
import { CopyButton } from "./CopyButton";
import { ErrorNotice } from "./ErrorNotice";
import { QuestionCard } from "./QuestionCard";
import { questionOf } from "./question-hooks";
import { Reasoning } from "./Reasoning";
import { ToolGroup } from "./ToolCard";
import { useAutomation } from "./automation-context";
import { primeSpeech, speak, speechSupported, stopSpeaking, useSpeakingKey } from "./voice";

const Markdown = lazy(() => import("./Markdown"));

interface MessageViewProps {
  message: Message;
  now: number;
  onOpenImage: (a: Attachment) => void;
  onRetry?: (() => void) | undefined;
  /** Set on the newest finished reply: asks the agent again with the same prompt. */
  onRegenerate?: (() => void) | undefined;
  /** The model the chat is configured with, shown when the agent reported none. */
  fallbackModel?: string | undefined;
  /** The chat uses a router model: the footer shows `auto -> <model>`. */
  autoChat?: boolean | undefined;
}

function Footer({ message, now, fallbackModel, autoChat, onRegenerate }: { message: Message; now: number; fallbackModel?: string | undefined; autoChat?: boolean | undefined; onRegenerate?: (() => void) | undefined }) {
  const ms = messageDurationMs(message, now);
  const tokens = formatTokens(message.input_tokens, message.output_tokens);
  return (
    <div className="msg-foot" data-testid="msg-foot">
      {message.status === "stopped" ? <span className="msg-status is-stopped">Stopped</span> : null}
      <SpeakButton message={message} />
      {message.content.trim() !== "" && !isLive(message) ? <CopyButton text={message.content} label="Copy" className="msg-act" /> : null}
      {onRegenerate !== undefined ? <button type="button" className="msg-act" data-testid="msg-regenerate" onClick={onRegenerate}>Regenerate</button> : null}
      {autoChat === true ? (
        <span className="msg-meta mono" data-testid="msg-model" title={message.model_used ?? "The agent did not report which model served this reply"}>{autoLabel(message.model_used)}</span>
      ) : message.model_used !== null ? (
        <span className="msg-meta mono" data-testid="msg-model">{message.model_used}</span>
      ) : fallbackModel !== undefined ? (
        <span className="msg-meta mono" data-testid="msg-model" title="The agent reported no model: this is the one the chat is set to">{fallbackModel}</span>
      ) : null}
      {message.selected_effort ? <span className="msg-meta mono" data-testid="msg-effort" title="Effort the hub recorded for this reply">effort {message.selected_effort}</span> : null}
      {message.selected_model ? <span className="msg-meta mono" data-testid="msg-selected-model" title="Model the hub recorded as selected">hub {message.selected_model}</span> : null}
      {ms !== null ? <span className="msg-meta mono" data-testid="msg-duration">{formatDuration(ms)}</span> : null}
      {tokens !== null ? <span className="msg-meta mono">{tokens}</span> : null}
      {message.cost_usd !== null ? <span className="msg-meta mono">{fmtUsd(message.cost_usd)}</span> : null}
    </div>
  );
}

/** Reads one reply aloud with the browser's speech synthesis; a second tap stops it. */
function SpeakButton({ message }: { message: Message }) {
  const speaking = useSpeakingKey() === message.id;
  if (!speechSupported() || message.content.trim() === "" || isLive(message)) {
    return null;
  }
  return (
    <button
      type="button"
      className={`icon-btn msg-speak${speaking ? " is-on" : ""}`}
      aria-label={speaking ? "Stop reading aloud" : "Read aloud"}
      title={speaking ? "Stop reading aloud" : "Read aloud"}
      aria-pressed={speaking}
      data-testid="msg-speak"
      onClick={() => {
        if (speaking) {
          stopSpeaking();
          return;
        }
        primeSpeech();
        void speak(message.content, message.id);
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4z" />
        {speaking ? <path d="M16 9l5 6M21 9l-5 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
      </svg>
    </button>
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

/** A run of consecutive tool-call rows, as cards. */
export function ToolsView({ messages, now }: { messages: Message[]; now: number }) {
  const calls = messages.flatMap((m) => {
    const parts = partsOf(m) ?? [];
    const part = parts.find((p) => p.type === "tool-call");
    return part?.type === "tool-call" ? [{ key: m.id, part, extra: parts.filter((p) => p.type !== "tool-call") }] : [];
  });
  return <ToolGroup calls={calls} now={now} />;
}


function UserMessage({ message, onOpenImage }: { message: Message; onOpenImage: (a: Attachment) => void }) {
  const automation = useAutomation();
  const scheduled = /^Scheduled: (.*)\n/.exec(message.content);
  return (
    <div className="msg msg-user" data-role="user">
      <div className="bubble">
        {scheduled !== null ? <p className="msg-schedule mono" data-testid="msg-scheduled">Scheduled · {scheduled[1]}</p> : null}
        {message.content !== "" ? <p className="user-text" dir="auto">{scheduled === null ? message.content : message.content.slice(scheduled[0].length).trim()}</p> : null}
        {message.attachments.length > 0 ? (
          <div className="att-row msg-atts" data-testid="msg-atts">
            {message.attachments.map((a) => (
              <AttachmentTile key={a.id} attachment={a} onOpen={onOpenImage} />
            ))}
          </div>
        ) : null}
      </div>
      {automation !== null && message.content.trim() !== "" ? (
        <div className="msg-foot">
          <button type="button" className="msg-act" data-testid="msg-schedule-this" onClick={() => { automation.openCreate("schedules", message.content); }}>Schedule this</button>
        </div>
      ) : null}
    </div>
  );
}

/** A result a schedule, loop or monitor posted: its title, a quiet counter, the text, and a link to the full run. Red only when it failed. */
function AutomationBlock({ message, part }: { message: Message; part: Extract<NonNullable<ReturnType<typeof partsOf>>[number], { type: "automation" }> }) {
  const failed = part.level === "error";
  const href = part.link === undefined ? null : part.link.startsWith("#") ? `/${part.link}` : part.link;
  return (
    <div className="msg msg-assistant" data-role="assistant" data-automation={part.kind}>
      <div className={`bubble auto-block${failed ? " is-error" : ""}`} role={failed ? "alert" : undefined} data-testid="automation-block">
        <div className="auto-block-head">
          <span className="auto-block-title" dir="auto">{part.title}</span>
          {part.counter !== undefined ? <span className="auto-block-count mono">{part.counter}</span> : null}
          <span className="auto-block-count">{rel(message.created_at)}</span>
          {href === null ? null : <a className="auto-block-link" href={href}>Open the full run</a>}
        </div>
        <Suspense fallback={<p className="user-text" dir="auto">{message.content}</p>}>
          <Markdown text={message.content} live={false} />
        </Suspense>
      </div>
    </div>
  );
}

export function MessageView({ message, now, onOpenImage, onRetry, onRegenerate, fallbackModel, autoChat }: MessageViewProps) {
  if (message.role === "tool") {
    const parts = partsOf(message);
    const thought = parts?.find((p) => p.type === "reasoning");
    if (thought?.type === "reasoning") {
      return <Reasoning id={message.id} text={thought.text} startedAt={message.started_at} finishedAt={message.finished_at} />;
    }
    const question = questionOf(message);
    if (question !== null) {
      return <QuestionCard part={question} onSubmit={async () => null} />;
    }
    if (parts?.some((p) => p.type === "tool-call") === true) {
      return <ToolsView messages={[message]} now={now} />;
    }
    return <ToolRow message={message} />;
  }
  if (message.role === "user") {
    return <UserMessage message={message} onOpenImage={onOpenImage} />;
  }
  const block = partsOf(message)?.find((p) => p.type === "automation");
  if (block?.type === "automation") {
    return <AutomationBlock message={message} part={block} />;
  }
  const live = isLive(message);
  return (
    <div className="msg msg-assistant" data-role={message.role}>
      <div className="bubble">
        {message.content === "" && (live || message.status === "error") ? null : (
          <Suspense fallback={<p className="user-text" dir="auto">{message.content}</p>}>
            <Markdown text={message.content} live={live} />
          </Suspense>
        )}
        {message.status === "error" ? <ErrorNotice error={message.error} onRetry={onRetry} /> : null}
      </div>
      {live ? null : <Footer message={message} now={now} fallbackModel={fallbackModel} autoChat={autoChat} onRegenerate={onRegenerate} />}
      {messageNotes(message).map((n) => (
        <p key={n.key} className="msg-warning" data-testid={`msg-${n.key}`} title={n.title}>{n.text}</p>
      ))}
    </div>
  );
}

