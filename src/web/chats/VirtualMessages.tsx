import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isLive, retryTarget } from "../lib/chat-logic";
import type { Attachment, Message } from "../lib/chat-types";
import { groupThread } from "./chat-group";
import { MessageView, ToolsView } from "./MessageView";
import { ThinkingContext, thinkingRowId } from "./thread-live";
import { WorkingIndicator } from "./WorkingIndicator";
import { useNow } from "./use-chat-thread";

const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 160;

interface Props {
  messages: Message[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
  onOpenImage: (a: Attachment) => void;
  onRetry: (text: string) => void;
  fallbackModel?: string | undefined;
  /** Rendered after the last message (the queued messages); `tailKey` changing keeps a bottom-stuck thread at the bottom. */
  tail?: ReactNode;
  tailKey?: number;
}

/** Virtualized thread. Sticks to the bottom only while the reader is there; prepends keep the reading position. */
export function VirtualMessages({ messages, hasOlder, loadingOlder, onLoadOlder, onOpenImage, onRetry, fallbackModel, tail, tailKey = 0 }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const stickRef = useRef(true);
  const anchor = useRef<{ firstId: string | null; height: number }>({ firstId: null, height: 0 });
  const anyLive = messages.some(isLive);
  const now = useNow(anyLive);
  const retry = retryTarget(messages);
  const working = [...messages].reverse().find((m) => m.role === "assistant" && isLive(m));
  const items = useMemo(() => groupThread(messages), [messages]);
  const thinking = useMemo(() => thinkingRowId(messages), [messages]);
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "user");
  const regen = lastReply !== undefined && lastReply.role === "assistant" && !isLive(lastReply) && retry === null
    ? [...messages].reverse().find((m) => m.role === "user" && m.id < lastReply.id)
    : undefined;

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 88,
    overscan: 8,
    getItemKey: (i) => { const it = items[i]; return it === undefined ? i : it.kind === "tools" ? it.id : it.message.id; },
  });

  const onScroll = useCallback(() => {
    const el = parent.current;
    if (el === null) {
      return;
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickRef.current = near;
    setStick(near);
    if (el.scrollTop < NEAR_TOP_PX && hasOlder && !loadingOlder) {
      anchor.current = { firstId: messages[0]?.id ?? null, height: el.scrollHeight };
      void onLoadOlder();
    }
  }, [hasOlder, loadingOlder, messages, onLoadOlder]);

  useLayoutEffect(() => {
    const el = parent.current;
    const first = messages[0]?.id ?? null;
    if (el !== null && anchor.current.firstId !== null && first !== anchor.current.firstId) {
      el.scrollTop += el.scrollHeight - anchor.current.height;
      anchor.current = { firstId: null, height: 0 };
    }
  }, [messages]);

  const total = virt.getTotalSize();
  useEffect(() => {
    const el = parent.current;
    if (el !== null && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [total, messages.length, working?.activity?.state, tailKey]);

  const jump = (): void => {
    const el = parent.current;
    if (el !== null) {
      stickRef.current = true;
      setStick(true);
      el.scrollTop = el.scrollHeight;
    }
  };

  return (
    <div className="thread-wrap">
      <ThinkingContext.Provider value={thinking}>
      <div className="thread-scroll" ref={parent} onScroll={onScroll} data-testid="thread-scroll">
        {loadingOlder ? <p className="thread-note">Loading earlier messages…</p> : null}
        {!hasOlder && messages.length > 0 ? <p className="thread-note">Start of the conversation</p> : null}
        <div className="thread-inner" style={{ height: total }}>
          {virt.getVirtualItems().map((item) => {
            const entry = items[item.index];
            if (entry === undefined) {
              return null;
            }
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virt.measureElement}
                className="thread-item"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {entry.kind === "tools" ? <ToolsView messages={entry.messages} now={now} /> : <MessageView
                  message={entry.message}
                  now={now}
                  fallbackModel={fallbackModel}
                  onOpenImage={onOpenImage}
                  onRetry={retry !== null && retry.assistant.id === entry.message.id ? () => { onRetry(retry.text); } : undefined}
                  onRegenerate={regen !== undefined && lastReply?.id === entry.message.id ? () => { onRetry(regen.content); } : undefined}
                />}
              </div>
            );
          })}
        </div>
        {working !== undefined ? <WorkingIndicator message={working} now={now} fallbackModel={fallbackModel} /> : null}
        {tail}
      </div>
      </ThinkingContext.Provider>
      {!stick ? (
        <button type="button" className="jump-pill" onClick={jump}>
          ↓ Jump to latest{anyLive ? " · working" : ""}
        </button>
      ) : null}
    </div>
  );
}
