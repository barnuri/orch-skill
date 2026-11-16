import { createContext, useContext } from "react";
import { parseParts } from "../../shared/chat-parts";
import type { Message } from "../lib/chat-types";
import { isLive } from "../lib/chat-logic";

/** The id of the thought row that is streaming right now: the newest reasoning row of a running reply whose answer has not started. */
export function thinkingRowId(messages: readonly Message[]): string | null {
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && isLive(m));
  if (reply === undefined || reply.content.trim() !== "") {
    return null;
  }
  const row = [...messages].reverse().find((m) => m.role === "tool" && parseParts(m.parts)?.some((p) => p.type === "reasoning") === true);
  return row?.id ?? null;
}

export const ThinkingContext = createContext<string | null>(null);
export const useThinkingId = (): string | null => useContext(ThinkingContext);

const seen = new Map<string, { first: number; last: number; len: number }>();

/** Seconds the model thought, as watched in this page; null when the row was loaded after the fact. */
export function observeThought(id: string, length: number, now: number): number | null {
  const prev = seen.get(id);
  if (prev === undefined) {
    seen.set(id, { first: now, last: now, len: length });
    return null;
  }
  if (length !== prev.len) {
    prev.len = length;
    prev.last = now;
  }
  return prev.last - prev.first;
}
