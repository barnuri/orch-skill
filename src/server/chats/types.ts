export type Role = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "pending" | "streaming" | "done" | "error" | "stopped";

export interface ProjectRow {
  id: string; name: string; path: string | null; description: string; created_at: string; archived_at: string | null;
  /** The parent project of a sub project; null for a top-level project. Sub projects are one level deep. */
  parent_id: string | null;
}

export interface ChatRow {
  id: string; project_id: string | null; title: string; harness: string; profile: string; model_id: string | null;
  session_id: string | null; status: "idle" | "running"; created_at: string; updated_at: string; archived_at: string | null;
  /** 1 once a person set the title (rename, or a title given at creation): the first message never replaces it. */
  title_manual: number;
  /** Absolute folder the agent runs in; null falls back to the project's folder, then to a scratch folder. */
  cwd: string | null;
  /** Relative folder inside the project's folder; applies when the chat has no folder of its own. */
  subfolder: string | null;
  /** low, medium, high or max; null is Auto: the harness gets no effort argument. */
  effort: string | null;
  /** 1 when a schedule, loop or monitor posted into the chat and nobody has opened it since. */
  unread: number;
}

export interface MessageRow {
  id: string; chat_id: string; role: Role; content: string; status: MessageStatus; error: string | null;
  model_used: string | null; input_tokens: number; output_tokens: number; cost_usd: number | null;
  started_at: string | null; finished_at: string | null; created_at: string;
  /** 1 when older turns were dropped from the history replayed into this reply's prompt. */
  context_truncated: number;
  /** Set when the stored session could not be resumed and the turn started fresh. */
  warning: string | null;
  /** JSON array of typed parts (src/shared/chat-parts.ts); null for rows written before parts existed: render `content`. */
  parts: string | null;
  /** Effort and model the hub recorded for this reply (`/api/smart-auto/history`); null when unknown. */
  selected_effort: string | null;
  selected_model: string | null;
}

export interface AttachmentRow {
  id: string; chat_id: string; message_id: string | null; filename: string; mime: string; size: number;
  sha256: string; rel_path: string; created_at: string;
  /** The queue row (`chat_queue.id`) that holds this upload until its message is sent; null for a plain pending upload. */
  queue_id: string | null;
}

export interface Page<T> { items: T[]; next_cursor: string | null }

export interface SearchHit {
  message_id: string; chat_id: string; chat_title: string; project_id: string | null; role: Role; created_at: string; snippet: string;
}
