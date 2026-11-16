import type { Chat } from "./chat-types";

/**
 * A chat that waits for the person's answer to a question the agent asked. The server flags it with `awaiting_answer`
 * (the question card); until a chat carries that flag nothing is waiting.
 */
export function chatIsWaiting(chat: Chat): boolean {
  return (chat as { awaiting_answer?: unknown }).awaiting_answer === true;
}
