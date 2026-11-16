import type { Chat } from "./chat-types";

/**
 * A chat that waits for the person's answer to a question the agent asked: its `status` is `waiting`. Older servers
 * flag it with `awaiting_answer` only, so that counts too.
 */
export function chatIsWaiting(chat: Chat): boolean {
  return chat.status === "waiting" || (chat as { awaiting_answer?: unknown }).awaiting_answer === true;
}
