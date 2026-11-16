import { useChat } from "./queries";

/** A link to a chat by its title; the other pages use it for results that return to a chat. */
export function ChatLink({ id, className }: { id: string; className?: string }) {
  const chat = useChat(id);
  return (
    <a className={className ?? "chat-link"} href={`#/chats/${encodeURIComponent(id)}`} title="Open the chat that gets the result" data-testid="chat-link">
      {chat.data?.title ?? "Chat"}
    </a>
  );
}
