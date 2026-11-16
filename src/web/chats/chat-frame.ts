import { createContext, useContext } from "react";
import "./column-gutter";

/** What the chat page needs to know about the shell that mounts it: AppShell (rail) or ChatShell (chat only). */
export interface ChatFrame {
  standalone: boolean;
}

export const ChatFrameContext = createContext<ChatFrame>({ standalone: false });

export const useChatFrame = (): ChatFrame => useContext(ChatFrameContext);
