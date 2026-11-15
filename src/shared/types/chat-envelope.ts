import type { ChatTurn } from "./chat-turn";

export interface ChatEnvelope {
  job_id: string;
  /** The harness session the turns came from, or null when orch assigned none. */
  session: string | null;
  /** Oldest first. The dashboard reverses for display; the wire order stays chronological. */
  turns: ChatTurn[];
  /** True when the transcript was longer than the server's cap and older turns were dropped. */
  truncated: boolean;
}
