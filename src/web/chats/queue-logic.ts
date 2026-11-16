/** The wire shapes of the chat queue (src/shared/dto/chat-queue.ts) and the pure helpers the tray uses. */
export interface QueueItem {
  id: string;
  chat_id: string;
  text: string;
  attachment_ids: string[];
  position: number;
  state: "queued" | "running" | "sent" | "cancelled";
  created_at: string;
  edited_at: string | null;
  message_id: string | null;
}

export interface QueueSnapshot {
  chat_id: string;
  items: QueueItem[];
  paused: boolean;
  reason: string | null;
  /** The agent's question waits for the person: the next queued message starts after it is answered or skipped. */
  waiting_for_answer?: boolean;
}

export const EMPTY_QUEUE: QueueSnapshot = { chat_id: "", items: [], paused: false, reason: null, waiting_for_answer: false };

export const PREVIEW_CHARS = 140;

export function waiting(snapshot: QueueSnapshot): QueueItem[] {
  return snapshot.items.filter((i) => i.state === "queued");
}

export function runningItem(snapshot: QueueSnapshot): QueueItem | null {
  return snapshot.items.find((i) => i.state === "running") ?? null;
}

/** One line of the message for a list: whitespace collapsed, cut at `max` with an ellipsis. */
export function preview(text: string, max: number = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function attachmentLabel(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/** The queued ids with `id` moved by `delta` places (clamped); the same array when it cannot move. */
export function moved(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  const to = Math.min(Math.max(from + delta, 0), ids.length - 1);
  if (from < 0 || from === to) {
    return [...ids];
  }
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** The queued ids with `id` dropped where `target` is (drag and drop): before `target` when moving up, after it when moving down. */
export function dropped(ids: readonly string[], id: string, target: string): string[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) {
    return [...ids];
  }
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function queuedCountLabel(count: number): string {
  return `${count} queued`;
}

/** Notice text for a paused queue, ending in what the person can do. */
export function pausedNotice(reason: string | null, count: number): string {
  const what = reason === null || reason === "" ? "The queue is paused." : `${reason.replace(/\.$/, "")}. The queue is paused.`;
  return `${what} ${count === 1 ? "1 message is" : `${count} messages are`} waiting.`;
}

/** Notice text while the agent's question holds the queue. */
export function waitingNotice(count: number): string {
  return `Waiting for your answer. ${count === 1 ? "1 message starts" : `${count} messages start`} after you answer or skip the question.`;
}
