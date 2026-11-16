import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, chatsApi, eventsUrl } from "../api/chats";
import { describeFailure } from "../api/result";
import { applyChatEvent, prependOlder, resumeId, sortMessages } from "../lib/chat-logic";
import type { Message } from "../lib/chat-types";
import { followSse } from "../lib/sse";
import type { ConnState } from "../lib/sse";
import { EMPTY_QUEUE } from "./queue-logic";
import type { QueueSnapshot } from "./queue-logic";

export interface ChatThread {
  messages: Message[];
  loading: boolean;
  loadError: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  running: boolean;
  /** The chat's message queue (queue event of the live stream). */
  queue: QueueSnapshot;
  setQueue: (queue: QueueSnapshot) => void;
  conn: ConnState;
  loadOlder: () => Promise<void>;
  send: (text: string, attachmentIds: readonly string[]) => Promise<string | null>;
  stop: () => Promise<void>;
}

/** Messages of one chat: first page over HTTP, then live events over a reconnecting fetch stream. */
export function useChatThread(chatId: string): ChatThread {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE);
  const [conn, setConn] = useState<ConnState>("connecting");
  const latest = useRef<Message[]>([]);
  latest.current = messages;

  useEffect(() => {
    const abort = new AbortController();
    setMessages([]);
    setLoading(true);
    setLoadError(null);
    setCursor(null);
    setRunning(false);
    setQueue(EMPTY_QUEUE);
    void (async () => {
      const page = await chatsApi.messages(chatId, null);
      if (abort.signal.aborted) {
        return;
      }
      if (page.kind !== "ok") {
        setLoadError(describeFailure(page, "could not load messages"));
        setLoading(false);
        return;
      }
      const initial = sortMessages(page.body.items);
      latest.current = initial;
      setMessages(initial);
      setCursor(page.body.next_cursor);
      setLoading(false);
      await followSse({
        url: eventsUrl(chatId),
        headers: authHeaders,
        resumeId: () => resumeId(latest.current),
        signal: abort.signal,
        onState: setConn,
        onEvents: (events) => {
          const now = new Date().toISOString();
          let next = latest.current;
          for (const ev of events) {
            let data: unknown = null;
            try {
              data = JSON.parse(ev.data);
            } catch {
              continue;
            }
            if (ev.event === "status") {
              const status = (data as { status?: unknown } | null)?.status;
              setRunning(status === "running");
            } else if (ev.event === "queue") {
              const snap = data as QueueSnapshot | null;
              if (snap !== null && Array.isArray(snap.items)) {
                setQueue(snap);
              }
            } else {
              next = applyChatEvent(next, { event: ev.event, data }, now);
            }
          }
          latest.current = next;
          setMessages(next);
        },
      });
    })();
    return () => {
      abort.abort();
    };
  }, [chatId]);

  const loadOlder = useCallback(async () => {
    if (cursor === null || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    const page = await chatsApi.messages(chatId, cursor);
    if (page.kind === "ok") {
      // Merged into `latest` at once, like the stream does: an SSE chunk that lands before the next
      // render must build on the older page, or its setMessages would drop that page again.
      const merged = prependOlder(latest.current, page.body.items);
      latest.current = merged;
      setMessages(merged);
      setCursor(page.body.next_cursor);
    }
    setLoadingOlder(false);
  }, [chatId, cursor, loadingOlder]);

  const send = useCallback(
    async (text: string, attachmentIds: readonly string[]): Promise<string | null> => {
      const res = await chatsApi.send(chatId, text, attachmentIds);
      return res.kind === "ok" ? null : describeFailure(res, "could not send");
    },
    [chatId],
  );

  const stop = useCallback(async () => {
    await chatsApi.stop(chatId);
  }, [chatId]);

  return { messages, loading, loadError, hasOlder: cursor !== null, loadingOlder, running, queue, setQueue, conn, loadOlder, send, stop };
}

/** A clock that ticks once a second while `active`, for live durations. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}
