// Feedback item shared by the core store, the CLI and the /api/feedback routes. Must stay Bun-free.

export const FEEDBACK_KINDS = ["bug", "idea", "ux", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = ["new", "queued", "working", "done", "wontfix"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_SOURCES = ["chat", "cli", "ui"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export interface FeedbackItem {
  id: string;
  text: string;
  source: FeedbackSource;
  chat_id?: string;
  run_id?: string;
  node_id?: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  created: string;
  updated: string;
  work_run?: string;
  result?: string;
  // Texts of later adds merged into this open item (same run+node, or same normalized text).
  notes?: FeedbackNote[];
}

export interface FeedbackNote {
  at: string;
  text: string;
  source: FeedbackSource;
}
