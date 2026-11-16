import { useRef, useState } from "react";
import { activityParts, type ChatActivity, formatClock } from "../../shared/chat-activity";
import { chatsApi } from "../api/chats";
import type { Message } from "../lib/chat-types";

interface Props {
  /** The reply that is running. */
  message: Message;
  now: number;
  /** The model the chat is set to, shown when the agent reported none. */
  fallbackModel?: string | undefined;
}

const START: ChatActivity["state"] = "starting";

/** What the agent is doing right now, from the server's heartbeat: dots, a label, a quiet clock and model. Turns amber with Stop when nothing arrives. */
export function WorkingIndicator({ message, now, fallbackModel }: Props) {
  const seen = useRef<{ activity: unknown; at: number }>({ activity: undefined, at: now });
  const [checked, setChecked] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const activity = message.activity ?? null;
  if (seen.current.activity !== activity) {
    seen.current = { activity, at: now };
  }
  const age = Math.max(0, now - seen.current.at);
  const started = message.started_at === null ? NaN : Date.parse(message.started_at);
  const base: ChatActivity = activity ?? { state: START, since: message.started_at ?? "", last_event_at: message.started_at ?? "", state_ms: 0, idle_ms: 0 };
  const idle = base.idle_ms + age;
  const { label, time, stalled } = activityParts(base, idle, base.state_ms + age);
  const elapsed = Number.isNaN(started) ? null : formatClock(now - started);
  const model = message.model_used ?? fallbackModel ?? null;
  const still = base.state === "waiting" || stalled;

  const check = async (): Promise<void> => {
    setChecked("Checking…");
    const page = await chatsApi.messages(message.chat_id, null, 10);
    const row = page.kind === "ok" ? page.body.items.find((m) => m.id === message.id) : undefined;
    if (page.kind !== "ok") {
      setChecked("Could not reach the server.");
    } else if (row === undefined || row.activity == null) {
      setChecked(row?.status === "streaming" ? "The server has no live process for this reply; it will be closed shortly." : "The reply has ended. Reload the thread to see it.");
    } else {
      setChecked(`The agent is running; it last sent something ${formatClock(row.activity.idle_ms)} ago.`);
    }
  };

  return (
    <div className={`working${stalled ? " is-stalled" : ""}`} data-testid="working" data-state={base.state} data-stalled={stalled}>
      <span className={`working-dots${still ? " is-still" : ""}`} aria-hidden="true"><i /><i /><i /></span>
      <span className="working-label" role="status" data-testid="working-label">{label}</span>
      {time !== null ? <span className="working-meta mono" data-testid="working-tool-time">{time}</span> : null}
      <span className="working-meta mono">
        {elapsed !== null ? <span data-testid="msg-duration">{elapsed}</span> : null}
        {model !== null ? <span data-testid="msg-model">{model}</span> : null}
      </span>
      {stalled ? (
        <span className="working-actions">
          <button type="button" className="btn working-stop" disabled={stopping} data-testid="working-stop" onClick={() => { setStopping(true); void chatsApi.stop(message.chat_id).finally(() => { setStopping(false); }); }}>Stop</button>
          <button type="button" className="link-btn" data-testid="working-check" onClick={() => { void check(); }}>Check status</button>
        </span>
      ) : null}
      {checked !== null ? <p className="working-checked" data-testid="working-checked">{checked}</p> : null}
    </div>
  );
}

/** The agent asked a question and waits: amber still dots and one plain line, no clock, no Stop. */
export function WaitingIndicator() {
  return (
    <div className="working is-waiting" data-testid="working-waiting" data-state="waiting-answer">
      <span className="working-dots is-still" aria-hidden="true"><i /><i /><i /></span>
      <span className="working-label" role="status" data-testid="working-label">Waiting for your answer</span>
    </div>
  );
}
