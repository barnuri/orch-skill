import type { ChatToolCall } from "./chat-tool-call";

export interface ChatTurn {
  /** The harness's own id for the turn, stable across reads, so the view can key on it. */
  id: string;
  role: "user" | "assistant";
  timestamp: string | null;
  /** Every text block in the turn, joined — empty for a turn that only called tools. */
  text: string;
  tools: ChatToolCall[];
}
