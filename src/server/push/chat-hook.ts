import type { QuestionPart } from "../../shared/chat-question";
import { chatUrl } from "../../shared/push";
import type { ChatEvent } from "../chats/service";
import type { MessageRow } from "../chats/types";
import type { PushHub } from "./hub";

/** The slice of ChatService the hook needs; keeps this file free of the service's imports. */
export interface ChatSource {
  events: Set<(chatId: string, ev: ChatEvent) => void>;
  store: { getChat(id: string): { title: string } | null; getMessage(id: string): MessageRow | null };
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/**
 * Turns chat events into notifications: reply ready, question waiting, reply failed, queue paused.
 * Raw tool output never goes in: a reply uses the assistant text only, a failure uses a fixed sentence plus the short error.
 */
export function attachChatPush(source: ChatSource, hub: PushHub): () => void {
  const pausedBefore = new Set<string>();
  const askedBefore = new Set<string>();
  const listener = (chatId: string, ev: ChatEvent): void => {
    const title = source.store.getChat(chatId)?.title || "Orch";
    const url = chatUrl(chatId);
    const tag = `chat:${chatId}`;
    const data = rec(ev.data);
    if (ev.event === "done") {
      const status = data["status"];
      const messageId = data["message_id"];
      if (status === "done" && typeof messageId === "string") {
        const text = source.store.getMessage(messageId)?.content ?? "";
        void hub.notify("replies", { title, body: text === "" ? "The reply is ready." : text, tag, url, chatId, waiting: true });
      } else if (status === "error") {
        const err = typeof data["error"] === "string" ? data["error"] : "";
        void hub.notify("failures", { title, body: err === "" ? "The reply failed." : `The reply failed: ${err}`, tag, url, chatId, waiting: true });
      }
      return;
    }
    if (ev.event === "message") {
      const parts = rec(rec(ev.data)["message"])["parts"];
      const q = Array.isArray(parts) ? (parts as QuestionPart[]).find((p) => p.type === "question" && p.state === "pending") : undefined;
      if (q !== undefined && !askedBefore.has(q.id)) {
        askedBefore.add(q.id);
        const first = q.questions[0];
        const actions = (first?.options ?? []).slice(0, 2).map((o, i) => ({ action: `opt:${i}`, title: o.label.slice(0, 40) }));
        void hub.notify("questions", { title, body: first?.question ?? "The agent has a question.", tag, url, chatId, actions, waiting: true });
      }
      return;
    }
    if (ev.event === "queue") {
      const paused = data["paused"] === true;
      const reason = typeof data["reason"] === "string" ? data["reason"] : "";
      const was = pausedBefore.has(chatId);
      if (paused) pausedBefore.add(chatId);
      else pausedBefore.delete(chatId);
      // "The reply was stopped." is the person's own Stop; a failed reply already sent its own notification.
      if (paused && !was && !/stopped|failed/i.test(reason)) {
        void hub.notify("failures", { title, body: `The queue is paused${reason === "" ? "." : `: ${reason}`}`, tag: `${tag}:queue`, url, chatId });
      }
    }
  };
  source.events.add(listener);
  return () => void source.events.delete(listener);
}
