import { type ChatPart, parseParts } from "../../shared/chat-parts";
import type { Message } from "../lib/chat-types";

export type ThreadItem = { kind: "message"; message: Message } | { kind: "tools"; id: string; messages: Message[] };

export const partsOf = (m: Message): ChatPart[] | null => parseParts(m.parts);

const isCall = (m: Message): boolean => m.role === "tool" && (partsOf(m)?.some((p) => p.type === "tool-call") ?? false);

/** Consecutive tool-call rows become one item (a group of cards); every other row stays its own item, old rows included. */
export function groupThread(messages: readonly Message[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (isCall(message)) {
      if (last?.kind === "tools") {
        last.messages.push(message);
      } else {
        out.push({ kind: "tools", id: message.id, messages: [message] });
      }
    } else {
      out.push({ kind: "message", message });
    }
  }
  return out;
}
